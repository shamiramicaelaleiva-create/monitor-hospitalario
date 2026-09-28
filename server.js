const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const mqttBrokers = process.env.MQTT_BROKERS
  ? JSON.parse(process.env.MQTT_BROKERS)
  : { [process.env.MQTT_ROOM || 'habitacion1']: process.env.MQTT_URL || 'mqtt://172.21.0.244:1883' };
const mqttTopicOverride = process.env.MQTT_TOPIC;
const mqttConnections = new Map();
const pacientes = new Map();

function emitirLectura({ habitacion, paciente, ritmo, estado = 'recibido', mensaje, origen, topic }) {
  const datos = {
    habitacion,
    paciente,
    ritmo,
    estado,
    mensaje: mensaje || 'Lectura recibida',
    origen,
    topic,
    timestamp: new Date().toISOString()
  };
  const identificador = `${habitacion}/${paciente}`;

  pacientes.set(identificador, datos);
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
  const mqttTopic = mqttTopicOverride || `${habitacionBroker}/+/bpm`;
  mqttConnections.set(habitacionBroker, false);

  mqttClient.on('connect', () => {
    console.log(`Conectado al broker MQTT de ${habitacionBroker}: ${mqttUrl}`);
    mqttConnections.set(habitacionBroker, true);
    emitirEstadoMqtt();
    mqttClient.subscribe(mqttTopic, (error) => {
      if (error) {
        console.error(`No se pudo suscribir a ${mqttTopic}:`, error.message);
        return;
      }
      console.log(`Suscripto al topic MQTT: ${mqttTopic}`);
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
    const partesTopic = topic.match(/^([^/]+)\/([^/]+)\/bpm$/);
    const ritmo = Number(lectura);
    if (!partesTopic || !Number.isFinite(ritmo) || ritmo <= 0) {
      console.warn(`Payload MQTT no numérico ignorado en ${topic}: ${lectura}`);
      return;
    }

    const [, habitacion, paciente] = partesTopic;
    emitirLectura({
      habitacion,
      paciente,
      ritmo,
      mensaje: 'Lectura recibida por MQTT',
      origen: 'MQTT',
      topic
    });
    console.log(`Lectura MQTT recibida en ${topic}: ${ritmo} BPM`);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de monitoreo activo en el puerto ${PORT}`);
});