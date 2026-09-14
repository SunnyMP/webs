# SyncSound

MVP de salas públicas para escuchar audio o ver una pantalla en tiempo real con WebRTC.

## Qué incluye

- Crear una sala pública con nombre, anfitrión y límite de participantes.
- Código corto y enlace de invitación.
- Unirse por código o por enlace directo.
- Panel separado para anfitrión e invitado.
- Captura bajo demanda con `getDisplayMedia()` y `getUserMedia()`.
- Fuentes: pestaña + audio, pantalla + audio, micrófono y pantalla + micrófono.
- Fuente adicional “solo audio de app”: usa el selector del navegador para elegir una pestaña o ventana; el navegador puede exigir que también se seleccione una pista de video, que la aplicación descarta.
- Salas públicas visibles en la portada y enlaces directos que piden únicamente el nombre del invitado.
- Previsualización local, estado de transmisión, lista de participantes, expulsión y bloqueo.
- WebRTC P2P con descubrimiento entre dispositivos mediante Trystero y relés públicos de Nostr.
- Manejo de permisos rechazados, pantalla detenida, sala llena y sala cerrada.
- No se graba ni se sube audio/video.

## Ejecutar localmente

Desde la carpeta del proyecto, sirve `dist/` con cualquier servidor HTTP. Por ejemplo:

```powershell
py -m http.server 4173 --directory dist
```

Después abre `http://localhost:4173/`.

Para probar el MVP abre la aplicación en dos navegadores o dispositivos: crea la sala en uno y usa el código/enlace en el otro. Para que una transmisión de pantalla/audio funcione, el navegador debe estar en un contexto seguro (`https` o `localhost`) y el usuario debe activar “Compartir audio” en el diálogo del navegador.

## Señalización pública

La aplicación usa Trystero para que los navegadores se descubran mediante relés públicos de Nostr. Las salas activas se anuncian temporalmente en un lobby P2P y desaparecen cuando el anfitrión se desconecta. El audio, el video y los datos de la sala viajan directamente entre pares y no se almacenan en GitHub Pages ni en un servidor de SyncSound.

La disponibilidad depende de que la red permita WebRTC y conexiones a los relés públicos. Para una versión con garantías operativas, moderación persistente o historial de salas se recomienda reemplazar los relés públicos por Firebase, Supabase o un servidor WebSocket propio.

Para muchas personas, la topología mesh de WebRTC no escala bien. La siguiente evolución recomendada es un SFU como LiveKit, mediasoup o Janus.

## Variables de entorno / configuración

La versión actual no necesita variables de entorno ni credenciales para funcionar.

## Compatibilidad y privacidad

La captura de audio depende del navegador y del sistema operativo. Chrome suele ofrecer más opciones para pestañas y pantalla, pero una ventana o aplicación no siempre expone audio. Una página web no puede capturar audio del sistema sin autorización explícita. Si se necesita capturar absolutamente todo el audio de Windows de forma consistente, conviene crear una aplicación de escritorio complementaria.

## Pruebas manuales básicas

- Crear sala: nombre, anfitrión, código y enlace.
- Unirse con código y con enlace.
- Sala llena y sala bloqueada.
- Compartir pestaña con audio y validar la previsualización.
- Compartir pantalla con audio y validar video/audio en la pestaña invitada.
- Detener la fuente desde la barra del navegador y verificar que la sala vuelve a “Sin transmisión”.
- Expulsar a un participante, bloquear nuevos ingresos y cerrar la sala.
- Salir/cerrar la pestaña del anfitrión y verificar que la sala se marca como cerrada.
