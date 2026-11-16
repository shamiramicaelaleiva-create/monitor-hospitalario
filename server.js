const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { AggregateField, getFirestore, FieldValue } = require('firebase-admin/firestore');
const PDFDocument = require('pdfkit');
const { filtrarLecturasPeriodo, parsearPeriodo, resumirLecturas } = require('./lib/informe');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const mqttBrokers = process.env.MQTT_BROKERS
  ? JSON.parse(process.env.MQTT_BROKERS)
  : { [process.env.MQTT_ROOM || 'habitacion1']: process.env.MQTT_URL || 'mqtt://172.21.0.244:1883' };
const mqttTopicOverride = process.env.MQTT_TOPIC;
const mqttConnections = new Map();
const pacientes = new Map();
const firestoreWriteEnabled = !['false', '0', 'no'].includes(
  (process.env.FIRESTORE_WRITE_ENABLED || 'true').toLowerCase()
);

let firestore = null;
const credentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  || process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (credentialPath) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.isAbsolute(credentialPath)
    ? credentialPath
    : path.resolve(__dirname, credentialPath);
  const firebaseOptions = { credential: applicationDefault() };
  if (process.env.FIREBASE_PROJECT_ID) {
    firebaseOptions.projectId = process.env.FIREBASE_PROJECT_ID;
  }
  initializeApp(firebaseOptions);
  firestore = getFirestore();
  console.log(firestoreWriteEnabled
    ? 'Persistencia Firestore habilitada'
    : 'Firestore habilitado en modo consulta; la persistencia de lecturas está desactivada');
} else {
  console.warn('Firestore no configurado; las lecturas solo se mantienen en memoria');
}

function guardarLectura(datos) {
  if (!firestore || !firestoreWriteEnabled) return;

  const documento = {
    habitacion: datos.habitacion,
    paciente: datos.paciente,
    topic: datos.topic,
    tipo: datos.tipo,
    valor: datos.valor,
    origen: datos.origen,
    estado: datos.estado,
    mensaje: datos.mensaje,
    fecha: FieldValue.serverTimestamp(),
    recibidoEnISO: datos.timestamp
  };

  firestore.collection('lecturas').doc().set(documento)
    .catch((error) => console.error('No se pudo guardar la lectura en Firestore:', error.message));
}

function emitirLectura({ habitacion, paciente, ritmo, temperatura, spo2, tipo = 'bpm', valor, estado = 'recibido', mensaje, origen, topic }) {
  const identificador = `${habitacion}/${paciente}`;
  const actual = pacientes.get(identificador) || {};
  const valorTipo = tipo === 'bpm' ? ritmo : tipo === 'temp' ? temperatura : spo2;
  const valorLectura = Number(valor ?? valorTipo);
  const datos = {
    habitacion,
    paciente,
    ritmo: Number.isFinite(Number(ritmo)) ? Number(ritmo) : actual.ritmo ?? null,
    temperatura: Number.isFinite(Number(temperatura)) ? Number(temperatura) : actual.temperatura ?? null,
    spo2: Number.isFinite(Number(spo2)) ? Number(spo2) : actual.spo2 ?? null,
    estado,
    mensaje: mensaje || 'Lectura recibida',
    origen,
    topic,
    tipo,
    valor: valorLectura,
    timestamp: new Date().toISOString()
  };

  pacientes.set(identificador, datos);
  guardarLectura(datos);
  io.emit('lectura-paciente', datos);
  return datos;
}

function emitirEstadoMqtt() {
  const activos = [...mqttConnections.values()].filter(Boolean).length;
  io.emit('mqtt-status', {
    connected: activos > 0,
    active: activos,
    total: mqttConnections.size
  });
}

function parsearMuestrasRaw(payload) {
  const contenido = payload.toString().trim();
  if (!contenido) return null;

  let muestras;

  try {
    const valor = JSON.parse(contenido);
    muestras = Array.isArray(valor) ? valor : [valor];
  } catch {
    muestras = contenido.split(/[,\s;]+/);
  }

  const valores = muestras.map((muestra) => (
    typeof muestra === 'number'
      ? muestra
      : typeof muestra === 'string' && muestra.trim()
        ? Number(muestra)
        : NaN
  ));
  return valores.length > 0 && valores.every(Number.isFinite) ? valores : null;
}

function parsearSpo2(payload) {
  const contenido = payload.toString().trim();
  const etiquetado = contenido.match(/^SpO2:\s*(\d+(?:[.,]\d+)?)\s*%$/i);
  const valorTexto = etiquetado ? etiquetado[1].replace(',', '.') : contenido;
  const valor = Number(valorTexto);
  return Number.isFinite(valor) ? valor : null;
}

// Middlewares para procesar JSON y servir archivos estáticos
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir la vista principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/informes', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'informes.html'));
});

app.get('/api/informes.pdf', async (req, res) => {
  if (!firestore) {
    return res.status(503).json({ error: 'Los informes requieren una conexión configurada con Firestore' });
  }

  const paciente = typeof req.query.paciente === 'string' ? req.query.paciente.trim() : '';
  const habitacion = typeof req.query.habitacion === 'string' ? req.query.habitacion.trim() : '';
  const inicio = typeof req.query.inicio === 'string' ? req.query.inicio : '';
  const fin = typeof req.query.fin === 'string' ? req.query.fin : '';
  const tienePeriodo = Boolean(inicio || fin);
  const periodo = tienePeriodo ? parsearPeriodo(inicio, fin) : null;
  if ((tienePeriodo && !periodo)
    || (!paciente && !periodo)
    || paciente.length > 100
    || habitacion.length > 100) {
    return res.status(400).json({
      error: 'Ingresá un nombre o identificador, o seleccioná un período completo válido. El fin debe ser posterior al inicio.'
    });
  }

  let lecturas;
  const promediosGenerales = {};
  try {
    let consulta = firestore.collection('lecturas');
    if (periodo) {
      consulta = consulta
        .where('recibidoEnISO', '>=', periodo.inicio)
        .where('recibidoEnISO', '<=', periodo.fin);
    }
    const snapshot = await consulta.get();
    lecturas = filtrarLecturasPeriodo(
      snapshot.docs.map((documento) => documento.data()),
      { ...periodo, paciente, habitacion }
    );

    if (!lecturas.length) {
      return res.status(404).json({ error: 'No se encontraron mediciones dentro del período seleccionado con esos filtros' });
    }

    const tipos = ['bpm', 'spo2', 'temp'];
    const resultadosPromedio = await Promise.all(tipos.map((tipo) => firestore.collection('lecturas')
      .where('tipo', '==', tipo)
      .aggregate({
        promedio: AggregateField.average('valor'),
        cantidad: AggregateField.count()
      })
      .get()));
    tipos.forEach((tipo, indice) => {
      promediosGenerales[tipo] = resultadosPromedio[indice].data();
    });
  } catch (error) {
    console.error('No se pudo consultar Firestore para el informe:', error.message);
    return res.status(500).json({ error: 'No se pudo consultar la base de datos para generar el informe' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="informe-de-sensado.pdf"');

  const titulo = paciente ? `Informe de sensado - ${paciente}` : 'Informe de sensado por período';
  const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: titulo } });
  pdf.on('error', (error) => {
    console.error('No se pudo generar el informe PDF:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el informe PDF' });
    else res.destroy(error);
  });
  pdf.pipe(res);

  const estadisticas = resumirLecturas(lecturas);
  const fechaInforme = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Argentina/Buenos_Aires'
  }).format(new Date());

  pdf.fillColor('#125d4d').fontSize(21).text('Informe de sensado');
  pdf.moveDown(0.35).fillColor('#202b28').fontSize(12);
  if (paciente) pdf.text(`Persona / identificador: ${paciente}`);
  else pdf.text('Persona / identificador: no especificado');
  if (habitacion) pdf.text(`Puesto / habitación: ${habitacion}`);
  pdf.fontSize(9).fillColor('#74807a').text(`Generado: ${fechaInforme}`);
  pdf.moveDown(0.5).fontSize(9).fillColor('#52605a')
    .text(periodo
      ? `Período seleccionado: ${formatearFecha(periodo.inicio)} — ${formatearFecha(periodo.fin)}`
      : 'Período seleccionado: todo el historial disponible para este identificador')
    .text(`Lecturas encontradas: ${formatearFecha(lecturas[0].recibidoEnISO || lecturas[0].fecha?.toDate?.())} — ${formatearFecha(lecturas.at(-1).recibidoEnISO || lecturas.at(-1).fecha?.toDate?.())}`)
    .text(`Cantidad de mediciones: ${lecturas.length}`);
  pdf.moveDown().fillColor('#202b28').fontSize(14).text('Resumen estadístico');

  const etiquetas = {
    bpm: ['Pulso', 'BPM'],
    spo2: ['Oxigenación', '%'],
    temp: ['Temperatura', '°C']
  };
  for (const tipo of ['bpm', 'spo2', 'temp']) {
    const resumen = estadisticas[tipo];
    if (!resumen.cantidad) continue;

    pdf.moveDown(0.4).fillColor('#125d4d').fontSize(11).text(etiquetas[tipo][0]);
    const alcance = paciente ? 'Promedio de la persona' : 'Promedio del período';
    pdf.fillColor('#202b28').fontSize(9)
      .text(`${alcance}: ${resumen.promedio.toFixed(2)} ${etiquetas[tipo][1]} · ${resumen.cantidad} lecturas`)
      .text(`Mediana: ${resumen.mediana.toFixed(2)} · mínimo: ${resumen.minimo.toFixed(2)} · máximo: ${resumen.maximo.toFixed(2)} ${etiquetas[tipo][1]}`)
      .text(`Variación observada (máximo - mínimo): ${(resumen.maximo - resumen.minimo).toFixed(2)} ${etiquetas[tipo][1]}`);

    const general = promediosGenerales[tipo];
    if (general.promedio !== null && general.cantidad > 0) {
      const diferencia = resumen.promedio - general.promedio;
      const comparacion = diferencia === 0
        ? 'igual al promedio del conjunto almacenado'
        : `${diferencia > 0 ? 'por encima' : 'por debajo'} del promedio del conjunto almacenado por ${Math.abs(diferencia).toFixed(2)} ${etiquetas[tipo][1]}${general.promedio ? ` (${Math.abs(diferencia / general.promedio * 100).toFixed(1)}%)` : ''}`;
      pdf.text(`Promedio de todas las personas: ${general.promedio.toFixed(2)} ${etiquetas[tipo][1]} (${general.cantidad} lecturas). Su promedio está ${comparacion}.`);
    }

    if (tipo === 'bpm') {
      pdf.text(`Dato curioso: ${resumen.porEncimaDelPromedio} de ${resumen.cantidad} mediciones (${(resumen.porEncimaDelPromedio / resumen.cantidad * 100).toFixed(1)}%) quedaron por encima de su propio promedio.`);
    }
  }

  pdf.moveDown().fillColor('#202b28').fontSize(14).text('Detalle de mediciones');
  pdf.moveDown(0.3).fontSize(8).fillColor('#52605a')
    .text('Fecha y hora · Dato · Valor');
  pdf.moveTo(48, pdf.y + 3).lineTo(547, pdf.y + 3).strokeColor('#e2e7e1').stroke();
  pdf.moveDown(0.45);
  const nombresTipo = { bpm: 'Pulso', spo2: 'Oxigenación', temp: 'Temperatura' };
  for (const lectura of lecturas) {
    const unidad = lectura.tipo === 'bpm' ? 'BPM' : lectura.tipo === 'spo2' ? '%' : '°C';
    pdf.fillColor('#202b28').fontSize(8)
      .text(`${formatearFecha(lectura.recibidoEnISO || lectura.fecha?.toDate?.())}     ${nombresTipo[lectura.tipo]}     ${lectura.valor} ${unidad}`);
  }

  pdf.moveDown().fillColor('#74807a').fontSize(8)
    .text('Este informe resume las lecturas almacenadas para la actividad. No es un diagnóstico ni una evaluación clínica; las mediciones dependen del sensor y de las condiciones de uso.');
  pdf.end();
});

function formatearFecha(fecha) {
  const valor = fecha instanceof Date ? fecha : new Date(fecha);
  if (!Number.isFinite(valor.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Argentina/Buenos_Aires'
  }).format(valor);
}

// Endpoint POST que recibe la alerta enviada por la Raspberry Pi / ESP32
app.post('/api/alerta', (req, res) => {
  const { ritmo, estado, mensaje, habitacion = 'general', paciente = 'sin-identificar' } = req.body;

  if (!Number.isFinite(Number(ritmo)) || Number(ritmo) <= 0 || !estado) {
    return res.status(400).json({ error: 'Se requieren ritmo numérico positivo y estado' });
  }

  const datosAlerta = emitirLectura({
    habitacion: String(habitacion),
    paciente: String(paciente),
    ritmo: Number(ritmo),
    tipo: 'bpm',
    valor: Number(ritmo),
    estado: String(estado),
    mensaje: mensaje || 'Alerta recibida por HTTP',
    origen: 'HTTP',
    topic: null
  });

  return res.status(200).json({ status: 'ok', mensaje: 'Alerta procesada', lectura: datosAlerta });
});

// Eventos de conexión de Socket.io
io.on('connection', (socket) => {
  console.log('Cliente web conectado:', socket.id);
  socket.emit('estado-inicial', Array.from(pacientes.values()));
  const activos = [...mqttConnections.values()].filter(Boolean).length;
  socket.emit('mqtt-status', {
    connected: activos > 0,
    active: activos,
    total: mqttConnections.size
  });

  socket.on('disconnect', () => {
    console.log('Cliente web desconectado:', socket.id);
  });
});

for (const [habitacionBroker, mqttUrl] of Object.entries(mqttBrokers)) {
  const mqttClient = mqtt.connect(mqttUrl, { reconnectPeriod: 2000 });
  const mqttTopics = [
    { tipo: 'bpm', topic: process.env.MQTT_BPM_TOPIC || mqttTopicOverride || `${habitacionBroker}/+/bpm` },
    { tipo: 'temp', topic: process.env.MQTT_TEMP_TOPIC || `${habitacionBroker}/+/temp` },
    { tipo: 'spo2', topic: process.env.MQTT_SPO2_TOPIC || `${habitacionBroker}/+/spo2` },
    { tipo: 'raw', topic: process.env.MQTT_RAW_TOPIC || `${habitacionBroker}/+/raw` }
  ];
  mqttConnections.set(habitacionBroker, false);

  mqttClient.on('connect', () => {
    console.log(`Conectado al broker MQTT de ${habitacionBroker}: ${mqttUrl}`);
    mqttConnections.set(habitacionBroker, true);
    emitirEstadoMqtt();

    mqttTopics.forEach(({ tipo, topic }) => {
      mqttClient.subscribe(topic, (error) => {
        if (error) {
          console.error(`No se pudo suscribir a ${topic} (${tipo}):`, error.message);
          return;
        }
        console.log(`Suscripto al topic MQTT: ${topic}`);
      });
    });
  });

  mqttClient.on('reconnect', () => {
    mqttConnections.set(habitacionBroker, false);
    emitirEstadoMqtt();
    console.log(`Reconectando al broker MQTT de ${habitacionBroker}...`);
  });

  mqttClient.on('close', () => {
    mqttConnections.set(habitacionBroker, false);
    emitirEstadoMqtt();
  });

  mqttClient.on('error', (error) => {
    mqttConnections.set(habitacionBroker, false);
    emitirEstadoMqtt();
    console.error(`Error MQTT en ${habitacionBroker}:`, error.message);
  });

  mqttClient.on('message', (topic, payload) => {
    const lectura = payload.toString().trim();
    const partesTopic = topic.match(/^([^/]+)\/([^/]+)\/(bpm|temp|spo2|raw)$/);
    if (!partesTopic) {
      return;
    }

    const [, habitacion, paciente, tipo] = partesTopic;
    if (tipo === 'raw') {
      const valores = parsearMuestrasRaw(payload);
      if (!valores) {
        console.warn(`Payload raw no numérico ignorado en ${topic}: ${lectura}`);
        return;
      }

      io.emit('raw-paciente', {
        habitacion,
        paciente,
        valores,
        timestamp: new Date().toISOString(),
        topic
      });
      return;
    }

    const esSpo2 = tipo === 'spo2';
    const valor = esSpo2 ? parsearSpo2(payload) : Number(lectura);
    if (!Number.isFinite(valor) || valor <= 0 || (esSpo2 && valor > 100)) {
      console.warn(`Payload MQTT inválido ignorado en ${topic}: ${lectura}`);
      return;
    }

    const datos = {
      habitacion,
      paciente,
      mensaje: 'Lectura recibida por MQTT',
      origen: 'MQTT',
      topic
    };

    if (tipo === 'bpm') {
      emitirLectura({
        ...datos,
        ritmo: valor,
        tipo: 'bpm',
        valor,
        estado: 'recibido'
      });
      console.log(`Lectura MQTT recibida en ${topic}: ${valor} BPM`);
      return;
    }

    if (esSpo2) {
      emitirLectura({
        ...datos,
        spo2: valor,
        tipo: 'spo2',
        valor,
        estado: 'recibido'
      });
      console.log(`Lectura MQTT recibida en ${topic}: ${valor}%`);
      return;
    }

    emitirLectura({
      ...datos,
      temperatura: valor,
      tipo: 'temp',
      valor,
      estado: 'recibido'
    });
    console.log(`Lectura MQTT recibida en ${topic}: ${valor} °C`);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de monitoreo activo en el puerto ${PORT}`);
});