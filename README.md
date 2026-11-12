# Monitor Hospitalario de Ritmo Cardíaco

Aplicación web para visualizar lecturas de ritmo cardíaco en tiempo real. El servidor
recibe alertas por HTTP o lecturas BPM por MQTT y las retransmite a los navegadores
conectados usando Socket.IO.

> **Importante:** este proyecto es una demostración técnica y no un dispositivo médico.
> No debe utilizarse para diagnóstico, tratamiento ni vigilancia clínica sin validación,
> controles de seguridad y supervisión profesional.

## Estado actual

- Recibe alertas mediante `POST /api/alerta`.
- Se suscribe por MQTT a `habitacion1/+/bpm`, `habitacion1/+/temp`, `habitacion1/+/spo2` y `habitacion1/+/raw` en `172.21.0.244:1883`.
- Identifica habitación y paciente a partir de topics como `habitacion1/paciente2/bpm`.
- Interpreta el payload MQTT como un BPM positivo enviado como texto, por ejemplo `87`.
- Muestra una tarjeta independiente con las últimas lecturas de BPM, temperatura, SpO2 y la señal raw de cada paciente.
- Grafica las muestras `raw` recibidas del sensor en tiempo real; no simula un ECG.
- Permite buscar pacientes y filtrar por habitación.
- Guarda cada lectura MQTT y HTTP como un documento independiente en Firestore cuando está configurado.
- Mantiene en memoria las últimas lecturas para la vista en tiempo real.
- Las lecturas MQTT se muestran como `recibido`; no se clasifican clínicamente.
- Conserva `POST /api/alerta` como vía opcional de ingreso por HTTP.
- Clasifica visualmente las alertas con los estados `normal`, `advertencia` y `peligro`.
- No incluye autenticación del endpoint de ingestión.

## Arquitectura

1. Cada ESP32 publica BPM y, opcionalmente, temperatura, SpO2 y muestras raw en topics con el formato `habitacion/paciente/tipo`.
2. El servidor Node.js se suscribe a esos topics y extrae habitación y paciente del topic.
3. El servidor guarda las lecturas BPM, temperatura y SpO2 en Firestore cuando está configurado; las muestras raw se envían en tiempo real y no se persisten.
4. Socket.IO envía las lecturas y muestras raw a los navegadores conectados; el monitor grafica directamente las muestras raw recibidas.
5. Cada navegador nuevo recibe las últimas lecturas disponibles en memoria.

## Tecnologías

- Node.js 18 o superior
- Express 5
- Socket.IO 4
- MQTT.js
- Firebase Admin SDK
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

## Configurar Firestore

1. Crea un proyecto en Firebase y habilita Cloud Firestore en modo nativo.
2. En la configuración del proyecto, crea una clave privada para una cuenta de servicio con permiso para escribir en Firestore.
3. Guarda el JSON descargado dentro de la carpeta del proyecto como `firebase-service-account.json`. No lo subas a Git ni lo compartas.
4. Copia `.env.example` a `.env` y configura la ruta del JSON:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
FIREBASE_PROJECT_ID=el-id-de-tu-proyecto
```

5. Reinicia el servidor con `npm run dev`.

Al iniciar debería aparecer `Persistencia Firestore habilitada`. Por cada habitación,
paciente y tipo (`bpm`, `temp` o `spo2`), el servidor escribe como máximo una vez cada 60
segundos. La primera lectura se guarda de inmediato y las siguientes se guardan
cuando hayan pasado al menos 60 segundos desde la última escritura exitosa. En cada
intervalo actualiza el documento correspondiente en `ultimas_lecturas` y agrega una
muestra a `lecturas`. Ambas escrituras se realizan juntas. Los documentos incluyen
`habitacion`, `paciente`, `topic`, `tipo`, `valor`, `origen`, `estado`, `mensaje`,
`fecha` y `recibidoEnISO`. La interfaz sigue recibiendo todas las lecturas en tiempo
real; Firestore conserva la última lectura y el historial muestreado, no cada mensaje
MQTT. Las muestras de temperatura y SpO2 también se guardan con este intervalo.

Los documentos guardados antes de este cambio no se eliminan automáticamente.

El mismo servicio guarda las lecturas HTTP recibidas por `/api/alerta`. Si Firestore
no está configurado, la aplicación sigue funcionando en tiempo real y avisa en la
terminal que las lecturas se mantienen solo en memoria.

Al iniciar, el servidor intenta conectarse al broker MQTT. En la terminal deberían
aparecer el broker conectado y los topics suscritos. Por defecto usa
`MQTT_URL=mqtt://172.21.0.244:1883` y se suscribe a `habitacion1/+/bpm`,
`habitacion1/+/temp`, `habitacion1/+/spo2` y `habitacion1/+/raw`. El comodín
`+` representa un segmento, así que recibirá paciente1, paciente2, paciente3, etc.,
de esa habitación. Si un mismo broker recibe varias habitaciones, se puede escuchar
el segmento de habitación también (cada tipo de dato se configura por separado):

```bash
MQTT_BPM_TOPIC='+/+/bpm' MQTT_TEMP_TOPIC='+/+/temp' MQTT_SPO2_TOPIC='+/+/spo2' MQTT_RAW_TOPIC='+/+/raw' npm run dev
```

Si cada habitación tiene su propio broker, configura `MQTT_BROKERS` como un objeto
JSON que asocie cada habitación con la dirección de su Raspberry Pi:

```bash
MQTT_BROKERS='{"habitacion1":"mqtt://172.21.0.244:1883","habitacion2":"mqtt://172.21.0.245:1883"}' npm run dev
```

En ese modo, el servidor se suscribe automáticamente a `habitacion/+/bpm`,
`habitacion/+/temp`, `habitacion/+/spo2` y `habitacion/+/raw` en cada broker. Los topics deben tener la
forma `habitacion/paciente/tipo`, donde `tipo` es `bpm`, `temp`, `spo2` o `raw`. Por ejemplo,
`habitacion1/Ana/bpm` mostrará `Ana` como paciente en la tarjeta; no se reemplaza
automáticamente por la palabra «Paciente».

El payload de BPM y temperatura debe ser un número positivo; el de `SpO2` puede enviarse
como `SpO2: 90.5 %` (también admite coma decimal, por ejemplo `SpO2: 90,5 %`) o como
número (`90.5`), entre 1 y 100. Para `raw`, se admiten
muestras numéricas individuales, separadas por comas/espacios o como un arreglo JSON,
por ejemplo `512`, `510,515,520` o `[510,515,520]`. La gráfica conserva las últimas 90
muestras, por lo que barre aproximadamente el doble de rápido que mostrando 180; su
velocidad física también depende de la frecuencia con que el ESP32 envía muestras.
Usa las muestras visibles para autoescalar
la señal; estos datos se muestran como los entrega el sensor y no tienen una unidad o
distancia asignada por el servidor. Si el sensor es óptico, la forma de onda puede incluir
variaciones del pulso periférico, pero no es un ECG: un ECG mide la actividad eléctrica
del corazón y requiere electrodos. La señal raw no se guarda en Firestore. Se puede
definir un patrón raw distinto con `MQTT_RAW_TOPIC` (por ejemplo
`MQTT_RAW_TOPIC='habitacion1/+/raw'`).

Para probar la integración, deja el servidor funcionando y publica una lectura de
SpO2 desde otra terminal:

```bash
mosquitto_pub -h 172.21.0.244 -p 1883 \
   -t 'habitacion1/paciente2/spo2' -m 'SpO2: 90.5 %'
```

El monitor debería crear o actualizar la tarjeta de `paciente2` en `habitacion1`.
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

| Campo       | Tipo    | Requerido | Descripción                           |
| ----------- | ------- | --------- | -------------------------------------- |
| `ritmo`   | número | Sí       | Ritmo cardíaco expresado en BPM.      |
| `estado`  | texto   | Sí       | Estado visual de la alerta.            |
| `mensaje` | texto   | No        | Descripción mostrada en el historial. |

Estados utilizados por la interfaz:

- `normal`
- `advertencia`
- `peligro`

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:3000/api/alerta \
   -H 'Content-Type: application/json' \
   -d '{"habitacion":"habitacion1","paciente":"paciente2","ritmo":92,"estado":"recibido","mensaje":"Lectura HTTP"}'
```

`habitacion` y `paciente` son opcionales; para identificar correctamente varios
pacientes por HTTP, envíalos en el cuerpo. MQTT sigue siendo la vía principal para la
ESP32 y HTTP queda disponible para otros integradores.

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

| Comando         | Descripción                                         |
| --------------- | ---------------------------------------------------- |
| `npm run dev` | Inicia el servidor con Node.js.                      |
| `npm test`    | Actualmente no hay una suite de pruebas configurada. |

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
