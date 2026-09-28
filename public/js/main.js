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

  const bpm = document.createElement('div');
  bpm.className = 'patient-bpm';
  const value = document.createElement('strong');
  const unit = document.createElement('span');
  unit.textContent = 'BPM';
  bpm.append(value, unit);

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

  card.append(cardTop, bpm, divider, details, topic);
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
  card.className = `patient-card status-${status}`;
  card.querySelector('.room-label').textContent = reading.habitacion;
  card.querySelector('.patient-name').textContent = reading.paciente;
  card.querySelector('.reading-state').textContent = status.toUpperCase();
  card.querySelector('.patient-bpm strong').textContent = reading.ritmo;
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
  if (!reading || !reading.habitacion || !reading.paciente || !Number.isFinite(Number(reading.ritmo))) return;
  const normalized = { ...reading, ritmo: Number(reading.ritmo) };
  readings.set(patientKey(normalized), normalized);
  renderCard(normalized);
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
searchInput.addEventListener('input', applyFilters);
roomFilter.addEventListener('change', applyFilters);