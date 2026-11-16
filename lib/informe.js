const TIPOS = ['bpm', 'spo2', 'temp'];

function normalizarIdentificador(valor) {
  return typeof valor === 'string'
    ? valor.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es')
    : '';
}

function mediana(valoresOrdenados) {
  const mitad = Math.floor(valoresOrdenados.length / 2);
  return valoresOrdenados.length % 2
    ? valoresOrdenados[mitad]
    : (valoresOrdenados[mitad - 1] + valoresOrdenados[mitad]) / 2;
}

function resumirLecturas(lecturas) {
  return Object.fromEntries(TIPOS.map((tipo) => {
    const valores = lecturas
      .filter((lectura) => lectura.tipo === tipo && typeof lectura.valor === 'number' && Number.isFinite(lectura.valor))
      .map((lectura) => lectura.valor)
      .sort((a, b) => a - b);

    if (!valores.length) {
      return [tipo, {
        cantidad: 0,
        promedio: null,
        mediana: null,
        minimo: null,
        maximo: null,
        porEncimaDelPromedio: 0
      }];
    }

    const promedio = valores.reduce((total, valor) => total + valor, 0) / valores.length;
    return [tipo, {
      cantidad: valores.length,
      promedio,
      mediana: mediana(valores),
      minimo: valores[0],
      maximo: valores.at(-1),
      porEncimaDelPromedio: valores.filter((valor) => valor > promedio).length
    }];
  }));
}

function parsearPeriodo(inicio, fin) {
  if (typeof inicio !== 'string' || typeof fin !== 'string') return null;

  const desde = new Date(inicio);
  const hasta = new Date(fin);
  if (!Number.isFinite(desde.getTime()) || !Number.isFinite(hasta.getTime()) || desde >= hasta) return null;

  return { inicio: desde.toISOString(), fin: hasta.toISOString() };
}

function filtrarLecturasPeriodo(lecturas, { inicio, fin, paciente, habitacion }) {
  const desde = inicio ? new Date(inicio).getTime() : null;
  const hasta = fin ? new Date(fin).getTime() : null;
  const pacienteNormalizado = normalizarIdentificador(paciente);
  const habitacionNormalizada = normalizarIdentificador(habitacion);

  return lecturas
    .filter((lectura) => {
      const fecha = new Date(lectura.recibidoEnISO || lectura.fecha?.toDate?.() || 0).getTime();
      return (desde === null || fecha >= desde)
        && (hasta === null || fecha <= hasta)
        && (!pacienteNormalizado || normalizarIdentificador(lectura.paciente) === pacienteNormalizado)
        && (!habitacionNormalizada || normalizarIdentificador(lectura.habitacion) === habitacionNormalizada)
        && ['bpm', 'spo2', 'temp'].includes(lectura.tipo)
        && typeof lectura.valor === 'number'
        && Number.isFinite(lectura.valor);
    })
    .sort((a, b) => new Date(a.recibidoEnISO || a.fecha?.toDate?.() || 0)
      - new Date(b.recibidoEnISO || b.fecha?.toDate?.() || 0));
}

module.exports = { filtrarLecturasPeriodo, normalizarIdentificador, parsearPeriodo, resumirLecturas };
