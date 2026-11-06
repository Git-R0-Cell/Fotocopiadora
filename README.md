# FOTOCOPIADORA

Convierte la foto de una cédula, licencia o tarjeta en una **fotocopia limpia**: recta, sin fondo, con las **esquinas redondeadas** de la tarjeta, y la guarda en un **PDF** con anverso y reverso listo para imprimir a tamaño real.

Todo se procesa en el navegador: las imágenes **no se suben a ningún servidor**. Funciona en el celular y en la PC, y se puede instalar como app (PWA).

## Qué hace

1. Detecta la tarjeta en la foto y corrige la perspectiva (queda recta aunque la foto esté torcida).
2. Borra el fondo y recorta con las esquinas redondeadas reales de la tarjeta (las mide de la foto; si no puede, usa el estándar de 3,18 mm).
3. Aplica el efecto fotocopia: quita sombras y luz despareja, sube el contraste y deja el papel en blanco.
4. Genera un PDF en hoja **Carta** con anverso arriba y reverso abajo, a **tamaño real** (85,6 × 54 mm, 300 ppp).

5. **Firma (opcional):** sube una foto de tu firma en papel; la app le quita el fondo (queda transparente), la pinta de azul de bolígrafo y la coloca **centrada entre el anverso y el reverso**.

Ajustes: hoja Carta o A4, una hoja o una por lado, escala de grises / blanco y negro / color, contraste, radio de esquinas, tamaño personalizado y borde fino de copiadora.

## Publicarlo en GitHub Pages

1. Crea un repositorio nuevo, por ejemplo `escaner-tarjetas`, y sube el contenido de esta carpeta a la raíz del repositorio. Incluye `.github/`, `.nojekyll` y, especialmente, `vendor/opencv.js`.
2. En GitHub abre **Settings → Pages** y elige **GitHub Actions** como fuente de publicación.
3. Cada push a `main` publicará automáticamente la aplicación. También puedes iniciar la publicación desde **Actions → Publicar en GitHub Pages → Run workflow**.
4. La dirección será `https://TU-USUARIO.github.io/escaner-tarjetas/` (cambia el usuario y nombre del repositorio según corresponda).
5. Ábrela en el celular y usa *Añadir a pantalla de inicio* para instalarla.

El archivo `vendor/opencv.js` pesa unos 13 MB y debe estar en el repositorio. La aplicación muestra el avance real de descarga, evita que la instalación de la PWA lo descargue en paralelo, guarda esa misma descarga para el siguiente uso sin conexión y ofrece reintentar si algo falla.

La cámara y el modo sin conexión solo funcionan con HTTPS; GitHub Pages ya lo incluye.

### Probarlo en tu computador antes de subirlo

Abrir `index.html` con doble clic no basta (el navegador bloquea parte de las funciones). Desde la carpeta:

```
python3 -m http.server 8000
```

y entra a `http://localhost:8000`.

## Uso

1. Pestaña **Anverso**: *Tomar foto* o *Elegir imagen*. Pon la tarjeta sobre una superficie lisa de otro color y con buena luz.
2. Si los 4 puntos no quedaron justo en las esquinas, arrástralos. La línea naranja marca el borde que quedará arriba; *Girar 90°* cambia la orientación.
3. Repite con **Reverso**.
4. Descarga el PDF (*Descargar PDF*) o ábrelo para imprimir. Imprime al 100 %, sin «ajustar a la página».

## Estructura

```
index.html, styles.css      interfaz
js/core.js                  motor: detección, enderezado, esquinas, efecto fotocopia, firma, diseño de hoja
js/app.js                   interfaz: editor de esquinas, firma, vista previa, PDF
icons/                      logo (impresora), íconos de la app y favicon
sw.js, manifest.webmanifest modo sin conexión e instalación como app
vendor/                     OpenCV.js 5.0 (Apache 2.0) y pdf-lib (MIT), incluidos para no depender de internet
```

## Firma

1. Abre la pestaña **Firma** y usa *Tomar foto* o *Elegir imagen* (no necesita esperar a que cargue el motor de imagen).
2. Arrastra las 4 esquinas del recuadro para dejar dentro solo la firma, sin el borde de la hoja ni la mesa.
3. Ajusta **Sensibilidad** (más alta = capta trazos más tenues, pero también más manchas) y **Tamaño** (ancho en mm en la hoja). Con *Girar 90°* corriges una foto tomada de lado.
4. Revisa la vista previa sobre cuadrícula (lo que se ve cuadriculado es transparente). *Descargar firma PNG* guarda la firma sola, con fondo transparente.

La firma se imprime solo con la disposición **«Anverso y reverso en una sola hoja»** (con «una hoja por cada lado» no hay espacio entre las dos caras). Si cargas solo una cara, la firma va debajo de ella. La firma no se guarda: al recargar la página hay que subirla de nuevo.

Para una firma limpia: lapicero oscuro sobre hoja blanca, buena luz y sin sombras fuertes sobre los trazos.

## Consejos para mejores resultados

- Evita reflejos sobre el plástico (luz de lado ayuda más que el flash).
- Una mesa oscura para tarjetas claras (o al revés) mejora la detección automática; si aun así falla, ajusta los puntos a mano.
- Las tarjetas con holograma o muy brillantes pueden quedar con zonas más claras; baja el contraste si es necesario.

## Licencias

Código de la app: úsalo y modifícalo libremente. OpenCV.js se distribuye bajo Apache 2.0 y pdf-lib bajo MIT; sus avisos de licencia pertenecen a sus autores.
