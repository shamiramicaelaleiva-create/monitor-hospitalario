const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

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
const ultimaPersistenciaEn = new Map();
const persistenciasPendientes = new Set();
const intervaloPersistenciaMs = 60_000;

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
  console.log('Persistencia Firestore habilitada');
} else {
  console.warn('Firestore no configurado; las lecturas solo se mantienen en memoria');
}

function guardarLectura(datos) {
  if (!firestore) return;

  const claveSensor = JSON.stringify([datos.habitacion, datos.paciente, datos.tipo]);
  const clave = encodeURIComponent(claveSensor);
  const ahora = Date.now();
  const ultimaPersistencia = ultimaPersistenciaEn.get(clave);
  if ((ultimaPersistencia && ahora - ultimaPersistencia < intervaloPersistenciaMs) || persistenciasPendientes.has(clave)) return;
  persistenciasPendientes.add(clave);

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

  const idHistorial = encodeURIComponent(JSON.stringify([claveSensor, ahora]));
  const lote = firestore.batch();
  lote.set(firestore.collection('ultimas_lecturas').doc(clave), documento);
  lote.set(firestore.collection('lecturas').doc(idHistorial), documento);
  lote.commit()
    .then(() => {
      ultimaPersistenciaEn.set(clave, Date.now());
      console.log(`Lectura de ${datos.tipo} guardada en Firestore para ${datos.habitacion}/${datos.paciente}`);
    })
    .catch((error) => console.error('No se pudo guardar la lectura en Firestore:', error.message))
    .finally(() => persistenciasPendientes.delete(clave));
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