const socket = io();

const patientGrid = document.getElementById('patient-grid');
const emptyState = document.getElementById('empty-state');
const patientCount = document.getElementById('patient-count');
const roomCount = document.getElementById('room-count');
const lastUpdate = document.getElementById('last-update');
const searchInput = document.getElementById('patient-search');
const roomFilter = document.getElementById('room-filter');
const mqttDot = document.getElementById('mqtt-dot');
const mqttLabel = document.getElementById('mqtt-label');
const connectionStatus = document.getElementById('connection-status');

const cards = new Map();
const readings = new Map();

const SIGNAL_TRACE_CONFIG = {
  window: 90
};

class SignalTrace {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.samples = [];
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  push(samples) {
    this.samples.push(...samples);
    if (this.samples.length > SIGNAL_TRACE_CONFIG.window) {
      this.samples.splice(0, this.samples.length - SIGNAL_TRACE_CONFIG.window);
    }
    this.draw();
  }

  draw() {
    const { context, width, height, samples } = this;
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    if (!samples.length) return;

    const minimum = Math.min(...samples);
    const maximum = Math.max(...samples);
    const span = Math.max(maximum - minimum, 1);
    const verticalPadding = height * 0.12;
    const plotHeight = height - verticalPadding * 2;

    context.beginPath();
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = '#42e6a4';
    context.shadowColor = '#42e6a4';
    context.shadowBlur = 6;

    samples.forEach((sample, index) => {
      const x = samples.length === 1 ? width : index / (samples.length - 1) * width;
      const y = height - verticalPadding - (sample - minimum) / span * plotHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });

    context.stroke();
    context.shadowBlur = 0;
  }
}

function patientKey(reading) {
  return `${reading.habitacion}/${reading.paciente}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(timestamp));
}

function createCard(reading) {
  const card = document.createElement('article');
  card.className = 'patient-card';
  card.dataset.key = patientKey(reading);

  const cardTop = document.createElement('div');
  cardTop.className = 'card-topline';
  const identity = document.createElement('div');
  identity.className = 'patient-identity';
  const room = document.createElement('span');
  room.className = 'room-label';
  const name = document.createElement('h3');
  name.className = 'patient-name';
  identity.append(room, name);
  const state = document.createElement('span');
  state.className = 'reading-state';
  cardTop.append(identity, state);

  const metrics = document.createElement('div');
  metrics.className = 'patient-metrics';

  const bpm = document.createElement('div');
  bpm.className = 'patient-bpm';
  const bpmValue = document.createElement('strong');
  const bpmUnit = document.createElement('span');
  bpmUnit.textContent = 'BPM';
  bpm.append(bpmValue, bpmUnit);

  const temp = document.createElement('div');
  temp.className = 'patient-temp';
  const tempValue = document.createElement('strong');
  const tempUnit = document.createElement('span');
  tempUnit.textContent = '°C';
  temp.append(tempValue, tempUnit);

  const spo2 = document.createElement('div');
  spo2.className = 'patient-spo2';
  const spo2Value = document.createElement('strong');
  const spo2Unit = document.createElement('span');
  spo2Unit.textContent = '%';
  spo2.append(spo2Value, spo2Unit);

  metrics.append(bpm, temp, spo2);

  const divider = document.createElement('div');
  divider.className = 'card-divider';
  const details = document.createElement('div');
  details.className = 'card-details';
  const updateLabel = document.createElement('span');
  updateLabel.textContent = 'ÚLTIMA LECTURA';
  const time = document.createElement('time');
  details.append(updateLabel, time);
  const topic = document.createElement('code');
  topic.className = 'topic-label';

  const signalSection = document.createElement('section');
  signalSection.className = 'signal-section raw-section';
  const signalLabel = document.createElement('h4');
  signalLabel.className = 'signal-label';
  signalLabel.textContent = 'SEÑAL REAL DEL SENSOR · NO ES ECG';
  const signalChart = document.createElement('div');
  signalChart.className = 'signal-chart raw-chart';
  signalChart.setAttribute('role', 'img');
  signalChart.setAttribute('aria-label', 'Gráfica en tiempo real de las muestras raw recibidas del sensor; no es una señal ECG');
  const rawCanvas = document.createElement('canvas');
  rawCanvas.setAttribute('aria-hidden', 'true');
  const signalPlaceholder = document.createElement('span');
  signalPlaceholder.className = 'signal-placeholder';
  signalPlaceholder.textContent = 'Esperando muestras reales del sensor';
  signalChart.append(rawCanvas, signalPlaceholder);
  signalSection.append(signalLabel, signalChart);

  card.append(cardTop, metrics, signalSection, divider, details, topic);
  card.signalTrace = new SignalTrace(rawCanvas);
  return card;
}

function renderCard(reading) {
  const key = patientKey(reading);
  let card = cards.get(key);
  if (!card) {
    card = createCard(reading);
    cards.set(key, card);
  }

  const status = ['normal', 'advertencia', 'peligro', 'recibido'].includes(reading.estado)
    ? reading.estado
    : 'recibido';
  const bpmValue = reading.ritmo !== null && reading.ritmo !== undefined && Number.isFinite(Number(reading.ritmo))
    ? Number(reading.ritmo)
    : null;
  const tempValue = reading.temperatura !== null && reading.temperatura !== undefined && Number.isFinite(Number(reading.temperatura))
    ? Number(reading.temperatura)
    : null;
  const spo2Value = reading.spo2 !== null && reading.spo2 !== undefined && Number.isFinite(Number(reading.spo2))
    ? Number(reading.spo2)
    : null;

  card.className = `patient-card status-${status}`;
  card.querySelector('.room-label').textContent = reading.habitacion;
  card.querySelector('.patient-name').textContent = reading.paciente;
  card.querySelector('.reading-state').textContent = status.toUpperCase();
  card.querySelector('.patient-bpm').hidden = bpmValue === null;
  card.querySelector('.patient-bpm strong').textContent = bpmValue !== null ? bpmValue : '--';
  card.querySelector('.patient-temp').hidden = tempValue === null;
  card.querySelector('.patient-temp strong').textContent = tempValue !== null ? tempValue.toFixed(1) : '--';
  card.querySelector('.patient-spo2').hidden = spo2Value === null;
  card.querySelector('.patient-spo2 strong').textContent = spo2Value !== null ? spo2Value : '--';
  card.querySelector('time').dateTime = reading.timestamp;
  card.querySelector('time').textContent = formatTime(reading.timestamp);
  card.querySelector('.topic-label').textContent = reading.topic || `${reading.habitacion}/${reading.paciente}`;
  patientGrid.append(card);
}

function updateFilters() {
  const currentRoom = roomFilter.value;
  const rooms = [...new Set([...readings.values()].map((reading) => reading.habitacion))].sort();
  roomFilter.replaceChildren(new Option('Todas las habitaciones', ''));
  rooms.forEach((room) => roomFilter.add(new Option(room, room)));
  roomFilter.value = rooms.includes(currentRoom) ? currentRoom : '';
}

function applyFilters() {
  const query = searchInput.value.trim().toLocaleLowerCase('es');
  let visibleCount = 0;

  readings.forEach((reading, key) => {
    const matchesRoom = !roomFilter.value || reading.habitacion === roomFilter.value;
    const searchable = `${reading.habitacion} ${reading.paciente}`.toLocaleLowerCase('es');
    const matchesQuery = !query || searchable.includes(query);
    const visible = matchesRoom && matchesQuery;
    cards.get(key).hidden = !visible;
    if (visible) visibleCount += 1;
  });

  emptyState.hidden = readings.size > 0;
  patientGrid.classList.toggle('filtered-empty', readings.size > 0 && visibleCount === 0);
}

function updateSummary() {
  const values = [...readings.values()];
  patientCount.textContent = values.length;
  roomCount.textContent = new Set(values.map((reading) => reading.habitacion)).size;
  lastUpdate.textContent = values.length
    ? formatTime(values.reduce((latest, reading) => reading.timestamp > latest ? reading.timestamp : latest, values[0].timestamp))
    : 'Sin lecturas';
  updateFilters();
  applyFilters();
}

function receiveReading(reading) {
  if (!reading || !reading.habitacion || !reading.paciente) return;

  const hasBpm = reading.ritmo !== undefined && reading.ritmo !== null && Number.isFinite(Number(reading.ritmo));
  const hasTemp = reading.temperatura !== undefined && reading.temperatura !== null && Number.isFinite(Number(reading.temperatura));
  const hasSpo2 = reading.spo2 !== undefined && reading.spo2 !== null && Number.isFinite(Number(reading.spo2));
  if (!hasBpm && !hasTemp && !hasSpo2) return;

  const normalized = {
    ...reading,
    ritmo: hasBpm ? Number(reading.ritmo) : null,
    temperatura: hasTemp ? Number(reading.temperatura) : null,
    spo2: hasSpo2 ? Number(reading.spo2) : null
  };

  readings.set(patientKey(normalized), normalized);
  renderCard(normalized);
  updateSummary();
}

function receiveRaw(raw) {
  if (!raw || !raw.habitacion || !raw.paciente || !Array.isArray(raw.valores)) return;
  if (!raw.valores.length || !raw.valores.every((value) => Number.isFinite(Number(value)))) return;

  const key = patientKey(raw);
  const existing = readings.get(key);
  const normalized = {
    ...(existing || {
      habitacion: raw.habitacion,
      paciente: raw.paciente,
      ritmo: null,
      temperatura: null,
      spo2: null,
      estado: 'recibido'
    }),
    timestamp: raw.timestamp || new Date().toISOString(),
    topic: raw.topic || `${raw.habitacion}/${raw.paciente}/raw`
  };

  readings.set(key, normalized);
  renderCard(normalized);
  const card = cards.get(key);
  card.signalTrace.push(raw.valores.map(Number));
  card.querySelector('.raw-chart').classList.add('has-data');
  updateSummary();
}

socket.on('connect', () => {
  connectionStatus.classList.add('is-connected');
  connectionStatus.lastElementChild.textContent = 'Servidor conectado';
});

socket.on('disconnect', () => {
  connectionStatus.classList.remove('is-connected');
  connectionStatus.lastElementChild.textContent = 'Servidor desconectado';
});

socket.on('mqtt-status', (status) => {
  const connected = typeof status === 'boolean' ? status : status.connected;
  const partial = typeof status === 'object' && status.active > 0 && status.active < status.total;
  mqttDot.classList.toggle('is-online', connected && !partial);
  mqttDot.classList.toggle('is-partial', partial);
  mqttLabel.textContent = typeof status === 'object' && status.total > 1
    ? `${status.active}/${status.total} conectados`
    : connected ? 'Conectado' : 'Desconectado';
});

socket.on('estado-inicial', (initialReadings) => {
  initialReadings.forEach(receiveReading);
});

socket.on('lectura-paciente', receiveReading);
socket.on('raw-paciente', receiveRaw);
searchInput.addEventListener('input', applyFilters);
roomFilter.addEventListener('change', applyFilters);