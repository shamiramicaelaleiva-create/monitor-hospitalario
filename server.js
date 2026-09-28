const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const mqttUrl = process.env.MQTT_URL || 'mqtt://172.21.0.244:1883';
const mqttTopic = process.env.MQTT_TOPIC || 'habitacion1/paciente1/bpm';
const mqttClient = mqtt.connect(mqttUrl, { reconnectPeriod: 2000 });

// Middlewares para procesar JSON y servir archivos estáticos
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir la vista principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Endpoint POST que recibe la alerta enviada por la Raspberry Pi / ESP32
app.post('/api/alerta', (req, res) => {
  const { ritmo, estado, mensaje } = req.body;

  if (ritmo === undefined || !estado) {
    return res.status(400).json({ error: 'Faltan parámetros (ritmo, estado)' });
  }

  const datosAlerta = {
    ritmo,
    estado,
    mensaje: mensaje || 'Alerta de ritmo cardíaco',
    timestamp: new Date().toLocaleTimeString()
  };

  // Reemitir en tiempo real mediante WebSockets a la web
  io.emit('nueva-alerta', datosAlerta);

  return res.status(200).json({ status: 'ok', mensaje: 'Alerta procesada' });
});

// Eventos de conexión de Socket.io
io.on('connection', (socket) => {
  console.log('Cliente web conectado:', socket.id);

  socket.on('disconnect', () => {
    console.log('Cliente web desconectado:', socket.id);
  });
});

mqttClient.on('connect', () => {
  console.log(`Conectado al broker MQTT: ${mqttUrl}`);
  mqttClient.subscribe(mqttTopic, (error) => {
    if (error) {
      console.error(`No se pudo suscribir a ${mqttTopic}:`, error.message);
      return;
    }
    console.log(`Suscripto al topic MQTT: ${mqttTopic}`);
  });
});

mqttClient.on('reconnect', () => {
  console.log('Reconectando al broker MQTT...');
});

mqttClient.on('error', (error) => {
  console.error('Error MQTT:', error.message);
});

mqttClient.on('message', (topic, payload) => {
  const lectura = payload.toString().trim();
  if (!/^\d+$/.test(lectura)) {
    console.warn(`Payload MQTT no numérico ignorado en ${topic}: ${lectura}`);
    return;
  }

  const datosAlerta = {
    ritmo: Number(lectura),
    estado: 'recibido',
    mensaje: 'Lectura recibida por MQTT',
    timestamp: new Date().toLocaleTimeString()
  };

  console.log(`Lectura MQTT recibida en ${topic}: ${lectura} BPM`);
  io.emit('nueva-alerta', datosAlerta);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de monitoreo activo en el puerto ${PORT}`);
});