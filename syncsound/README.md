# SyncSound

MVP de salas privadas para escuchar audio o ver una pantalla en tiempo real con WebRTC nativo.

## Qué incluye

- Crear una sala con nombre, anfitrión, contraseña opcional y límite de participantes.
- Código corto y enlace de invitación.
- Unirse por código o por enlace directo.
- Panel separado para anfitrión e invitado.
- Captura bajo demanda con `getDisplayMedia()` y `getUserMedia()`.
- Fuentes: pestaña + audio, pantalla + audio, micrófono y pantalla + micrófono.
- Fuente adicional “solo audio de app”: usa el selector del navegador para elegir una pestaña o ventana; el navegador puede exigir que también se seleccione una pista de video, que la aplicación descarta.
- Salas públicas visibles en la portada y enlaces directos que piden únicamente el nombre del invitado.
- Previsualización local, estado de transmisión, lista de participantes, expulsión y bloqueo.
- WebRTC nativo con STUN público y señalización local entre pestañas mediante `BroadcastChannel`.
- Manejo de permisos rechazados, pantalla detenida, sala llena, contraseña incorrecta y sala cerrada.
- No se graba ni se sube audio/video.

## Ejecutar localmente

Desde la carpeta del proyecto, sirve `dist/` con cualquier servidor HTTP. Por ejemplo:

```powershell
py -m http.server 4173 --directory dist
```

Después abre `http://localhost:4173/`.

Para probar el MVP local abre dos pestañas del mismo navegador: crea la sala en una y usa el código/enlace en la otra. Para que una transmisión de pantalla/audio funcione, el navegador debe estar en un contexto seguro (`https` o `localhost`) y el usuario debe activar “Compartir audio” en el diálogo del navegador.

## Limitación actual de señalización

La demo usa `BroadcastChannel` y `localStorage`, por lo que la prueba P2P completa está pensada para dos o más pestañas del mismo origen/navegador. La lista de salas públicas también se actualiza localmente. Un enlace abierto desde otro dispositivo todavía necesita una señalización compartida; GitHub Pages no puede guardar esa lista por sí solo. La carpeta ya deja documentado el punto de sustitución para Firebase Realtime Database/Firestore. Para publicar una versión multi-dispositivo hay que:

1. Crear un proyecto Firebase.
2. Activar Authentication anónima y Realtime Database.
3. Copiar `firebase-config.example.js` como `dist/firebase-config.js` y completar sus valores.
4. Sustituir la capa `send()`/`handleSignal()` por listeners de Firebase y usar `onDisconnect()` para borrar participantes y cerrar la sala del anfitrión.
5. Configurar reglas que expiren o limpien `rooms/{roomId}/participants` y `rooms/{roomId}/signals`; nunca guardar media.

Para muchas personas, la topología mesh de WebRTC no escala bien. La siguiente evolución recomendada es un SFU como LiveKit, mediasoup o Janus.

## Variables de entorno / configuración

En la versión estática no se inyectan variables de entorno. `firebase-config.example.js` documenta las claves públicas del cliente Firebase. Las reglas y credenciales administrativas deben vivir fuera del frontend.

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
