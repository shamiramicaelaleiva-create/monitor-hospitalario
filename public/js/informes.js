const reportForm = document.getElementById('report-form');
const reportSubmit = document.getElementById('report-submit');
const reportMessage = document.getElementById('report-message');

reportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  reportMessage.textContent = '';
  reportMessage.classList.remove('is-error');
  reportSubmit.disabled = true;
  reportSubmit.textContent = 'Generando informe…';

  try {
    const datos = new FormData(reportForm);
    const inicioTexto = datos.get('inicio');
    const finTexto = datos.get('fin');
    const paciente = datos.get('paciente').trim();
    if (Boolean(inicioTexto) !== Boolean(finTexto)) {
      throw new Error('Completá las dos fechas del período o dejá ambas vacías.');
    }

    if (inicioTexto && finTexto) {
      const inicio = new Date(inicioTexto);
      const fin = new Date(finTexto);
      if (!Number.isFinite(inicio.getTime()) || !Number.isFinite(fin.getTime()) || inicio >= fin) {
        throw new Error('El fin del sensado debe ser posterior al inicio.');
      }

      datos.set('inicio', inicio.toISOString());
      datos.set('fin', fin.toISOString());
    }

    if (!paciente && !inicioTexto) {
      throw new Error('Ingresá un nombre o identificador, o seleccioná un período de sensado.');
    }

    const parametros = new URLSearchParams(datos);
    const respuesta = await fetch(`/api/informes.pdf?${parametros}`);
    if (!respuesta.ok) {
      const resultado = await respuesta.json();
      throw new Error(resultado.error || 'No se pudo generar el informe');
    }

    const archivo = URL.createObjectURL(await respuesta.blob());
    const enlace = document.createElement('a');
    enlace.href = archivo;
    enlace.download = 'informe-de-sensado.pdf';
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
    window.setTimeout(() => URL.revokeObjectURL(archivo), 1000);
    reportMessage.textContent = 'Informe descargado.';
  } catch (error) {
    reportMessage.textContent = error.message;
    reportMessage.classList.add('is-error');
  } finally {
    reportSubmit.disabled = false;
    reportSubmit.textContent = 'Generar y descargar PDF';
  }
});
