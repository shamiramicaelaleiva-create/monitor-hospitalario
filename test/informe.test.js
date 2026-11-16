const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filtrarLecturasPeriodo,
  normalizarIdentificador,
  parsearPeriodo,
  resumirLecturas
} = require('../lib/informe');

test('resume cada tipo con promedio, mediana, extremos y conteo sobre el promedio', () => {
  const resultado = resumirLecturas([
    { tipo: 'bpm', valor: 60 },
    { tipo: 'bpm', valor: 80 },
    { tipo: 'bpm', valor: 100 },
    { tipo: 'spo2', valor: 96 },
    { tipo: 'spo2', valor: 98 },
    { tipo: 'temp', valor: 36.5 }
  ]);

  assert.deepEqual(resultado.bpm, {
    cantidad: 3,
    promedio: 80,
    mediana: 80,
    minimo: 60,
    maximo: 100,
    porEncimaDelPromedio: 1
  });
  assert.equal(resultado.spo2.promedio, 97);
  assert.equal(resultado.temp.cantidad, 1);
});

test('ignora valores inválidos y representa tipos sin lecturas', () => {
  const resultado = resumirLecturas([
    { tipo: 'bpm', valor: NaN },
    { tipo: 'raw', valor: 512 },
    { tipo: 'temp', valor: '36.5' }
  ]);

  assert.equal(resultado.bpm.cantidad, 0);
  assert.equal(resultado.bpm.promedio, null);
  assert.equal(resultado.spo2.cantidad, 0);
  assert.equal(resultado.temp.cantidad, 0);
});

test('calcula correctamente la mediana de una cantidad par de lecturas', () => {
  const resultado = resumirLecturas([
    { tipo: 'bpm', valor: 70 },
    { tipo: 'bpm', valor: 90 }
  ]);

  assert.equal(resultado.bpm.mediana, 80);
});

test('normaliza el período seleccionado y rechaza fechas inválidas o invertidas', () => {
  assert.deepEqual(parsearPeriodo('2026-11-13T10:00:00-03:00', '2026-11-13T11:00:00-03:00'), {
    inicio: '2026-11-13T13:00:00.000Z',
    fin: '2026-11-13T14:00:00.000Z'
  });
  assert.equal(parsearPeriodo('fecha inválida', '2026-11-13T14:00:00.000Z'), null);
  assert.equal(parsearPeriodo('2026-11-13T14:00:00.000Z', '2026-11-13T14:00:00.000Z'), null);
  assert.equal(parsearPeriodo('2026-11-13T15:00:00.000Z', '2026-11-13T14:00:00.000Z'), null);
});

test('filtra la sesión por período inclusivo y aplica identificadores opcionales', () => {
  const lecturas = [
    { recibidoEnISO: '2026-11-13T14:00:00.000Z', paciente: 'desconocido', habitacion: 'puesto1', tipo: 'bpm', valor: 70 },
    { recibidoEnISO: '2026-11-13T14:30:00.000Z', paciente: 'otra-persona', habitacion: 'puesto2', tipo: 'spo2', valor: 98 },
    { recibidoEnISO: '2026-11-13T15:00:00.000Z', paciente: 'desconocido', habitacion: 'puesto1', tipo: 'temp', valor: 36.5 },
    { recibidoEnISO: '2026-11-13T15:00:00.001Z', paciente: 'desconocido', habitacion: 'puesto1', tipo: 'bpm', valor: 80 },
    { recibidoEnISO: '2026-11-13T14:15:00.000Z', paciente: 'desconocido', habitacion: 'puesto1', tipo: 'raw', valor: 512 }
  ];

  const porHorario = filtrarLecturasPeriodo(lecturas, {
    inicio: '2026-11-13T14:00:00.000Z',
    fin: '2026-11-13T15:00:00.000Z',
    paciente: '',
    habitacion: ''
  });
  assert.deepEqual(porHorario.map((lectura) => lectura.valor), [70, 98, 36.5]);

  const porSesionIdentificada = filtrarLecturasPeriodo(lecturas, {
    inicio: '2026-11-13T14:00:00.000Z',
    fin: '2026-11-13T15:00:00.000Z',
    paciente: 'desconocido',
    habitacion: 'puesto1'
  });
  assert.deepEqual(porSesionIdentificada.map((lectura) => lectura.valor), [70, 36.5]);
});

test('permite filtrar solo por identificador cuando no se especifica un período', () => {
  const resultado = filtrarLecturasPeriodo([
    { recibidoEnISO: '2026-11-13T10:00:00.000Z', paciente: 'Ana', habitacion: 'puesto1', tipo: 'bpm', valor: 70 },
    { recibidoEnISO: '2026-11-13T11:00:00.000Z', paciente: 'Ana', habitacion: 'puesto1', tipo: 'spo2', valor: 98 },
    { recibidoEnISO: '2026-11-13T11:00:00.000Z', paciente: 'Luis', habitacion: 'puesto1', tipo: 'bpm', valor: 80 }
  ], { inicio: '', fin: '', paciente: 'Ana', habitacion: '' });

  assert.deepEqual(resultado.map((lectura) => lectura.valor), [70, 98]);
});

test('compara nombres y habitaciones ignorando mayúsculas y espacios sobrantes', () => {
  assert.equal(normalizarIdentificador('  Juan   Perez  '), 'juan perez');

  const resultado = filtrarLecturasPeriodo([
    { recibidoEnISO: '2026-11-13T10:00:00.000Z', paciente: 'juan', habitacion: ' Puesto   Uno ', tipo: 'bpm', valor: 70 },
    { recibidoEnISO: '2026-11-13T11:00:00.000Z', paciente: 'JUAN', habitacion: 'puesto uno', tipo: 'spo2', valor: 98 },
    { recibidoEnISO: '2026-11-13T12:00:00.000Z', paciente: 'Juan Perez', habitacion: 'Puesto Dos', tipo: 'bpm', valor: 80 }
  ], {
    inicio: '',
    fin: '',
    paciente: '  JuAn  ',
    habitacion: 'puesto uno'
  });

  assert.deepEqual(resultado.map((lectura) => lectura.valor), [70, 98]);
});
