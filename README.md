# Monitor Hospitalario de Ritmo Cardíaco

Aplicación web para visualizar lecturas de ritmo cardíaco en tiempo real. El servidor
recibe alertas por HTTP o lecturas BPM por MQTT y las retransmite a los navegadores
conectados usando Socket.IO.

> **Importante:** este proyecto es una demostración técnica y no un dispositivo médico.
> No debe utilizarse para diagnóstico, tratamiento ni vigilancia clínica sin validación,
> controles de seguridad y supervisión profesional.

## Estado actual

- Recibe alertas mediante `POST /api/alerta`.
- Se suscribe por MQTT a `habitacion1/paciente1/bpm` en `172.21.0.244:1883`.
- Interpreta el payload MQTT como un BPM entero enviado como texto, por ejemplo `87`.
- Las lecturas MQTT se muestran con el estado `recibido`; no se clasifican clínicamente.
- Actualiza el último ritmo medido en los clientes conectados.
- Muestra un historial en memoria en cada navegador.
- Clasifica visualmente las alertas con los estados `normal`, `advertencia` y `peligro`.
- No persiste alertas en una base de datos.
- No incluye autenticación del endpoint de ingestión.

## Arquitectura

1. La ESP32 publica el BPM como texto en `habitacion1/paciente1/bpm`.
2. El servidor Node.js se suscribe al broker MQTT y recibe el mensaje.
3. Socket.IO emite la lectura a los navegadores conectados.
4. La interfaz web actualiza el indicador principal y el historial sin recargar la página.

## Tecnologías

- Node.js 18 o superior
- Express 5
- Socket.IO 4
- MQTT.js
- HTML, CSS y JavaScript sin framework

## Requisitos

- Node.js 18 o superior
- npm

## Instalación

Desde la carpeta del proyecto:

```bash
npm install
```

## Ejecución local

```bash
npm run dev
```

Luego abrí [http://localhost:3000](http://localhost:3000) en el navegador.

Al iniciar, el servidor intenta conectarse al broker MQTT. En la terminal deberían
aparecer `Conectado al broker MQTT` y `Suscripto al topic MQTT`. Si la dirección o el
topic son distintos, se pueden configurar con `MQTT_URL` y `MQTT_TOPIC`.

Para probar la integración, deja el servidor funcionando y publica un BPM desde otra
terminal:

```bash
mosquitto_pub -h 172.21.0.244 -p 1883 \\
   -t 'habitacion1/paciente1/bpm' -m '87'
```

El monitor debería mostrar `87 BPM` y agregar una entrada con estado `RECIBIDO`.
También se puede observar el topic directamente con `mosquitto_sub`.

El puerto puede cambiarse mediante la variable de entorno `PORT`:

```bash
PORT=4000 npm run dev
```

## API de alertas

### `POST /api/alerta`

Recibe un objeto JSON con los datos de la alerta.

#### Cuerpo esperado

```json
{
   "ritmo": 92,
   "estado": "advertencia",
   "mensaje": "Ritmo por encima del rango configurado"
}
```

Campos:

| Campo | Tipo | Requerido | Descripción |
| --- | --- | --- | --- |
| `ritmo` | número | Sí | Ritmo cardíaco expresado en BPM. |
| `estado` | texto | Sí | Estado visual de la alerta. |
| `mensaje` | texto | No | Descripción mostrada en el historial. |

Estados utilizados por la interfaz:

- `normal`
- `advertencia`
- `peligro`

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:3000/api/alerta \
   -H 'Content-Type: application/json' \
   -d '{"ritmo":92,"estado":"advertencia","mensaje":"Ritmo elevado"}'
```

Respuesta exitosa:

```json
{
   "status": "ok",
   "mensaje": "Alerta procesada"
}
```

Si faltan `ritmo` o `estado`, el servidor responde con HTTP `400`.

## Estructura del proyecto

```text
monitor-hospitalario/
├── server.js              # Servidor Express y Socket.IO
├── package.json            # Dependencias y scripts
├── vercel.json             # Configuración de despliegue
├── public/
│   ├── css/style.css       # Estilos de la interfaz
│   └── js/main.js          # Cliente Socket.IO y renderizado
└── views/index.html        # Vista principal
```

## Scripts disponibles

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Inicia el servidor con Node.js. |
| `npm test` | Actualmente no hay una suite de pruebas configurada. |

## Seguridad y producción

Antes de conectar sensores reales o datos de pacientes, se recomienda:

- proteger `POST /api/alerta` con autenticación y autorización;
- validar tipos, rangos y estados permitidos en el servidor;
- limitar el tamaño y la frecuencia de las peticiones;
- usar HTTPS y cabeceras de seguridad;
- evitar insertar datos recibidos con `innerHTML` en el navegador;
- persistir las alertas en una base de datos si deben conservarse;
- registrar errores y eventos relevantes sin exponer datos sensibles.

Socket.IO requiere conexiones persistentes. La configuración de Vercel incluida en el
proyecto debe verificarse antes de producción, porque las funciones serverless no son
adecuadas para mantener WebSockets abiertos por sí solas. En ese caso, usá un servidor
Node.js persistente o un proveedor de WebSockets compatible.

## Licencia

El proyecto declara actualmente la licencia `ISC` en `package.json`.
