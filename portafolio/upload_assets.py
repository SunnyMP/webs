"""
upload_assets.py
Sube imágenes a imgbb.com y actualiza los HTML del portfolio con los nuevos links.
Para videos: instrucciones al final del script.

USO:
  1. Consigue tu API key gratis en https://api.imgbb.com/
  2. Ejecuta: python upload_assets.py --key TU_API_KEY
  3. Si ya tienes URLs de videos, edita el dict MANUAL_VIDEO_URLS abajo y vuelve a ejecutar.
"""

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("Instala requests: pip install requests")
    sys.exit(1)

# ─── Configuración ────────────────────────────────────────────────────────────

ASSETS_DIR = Path(__file__).parent / "assets"
MAPPING_FILE = Path(__file__).parent / "asset_urls.json"

# Archivos HTML que se actualizarán automáticamente
HTML_FILES = ["index.html", "concept-weeb.html", "wikis.html"]

# ─── VIDEOS ───────────────────────────────────────────────────────────────────
# Sube los videos manualmente a Cloudinary (gratis en cloudinary.com)
# y pega aquí los links directos. Deben terminar en .mp4
# Ejemplo: "bg-mitsuha-stars.mp4": "https://res.cloudinary.com/TU-CLOUD/video/upload/v.../bg-mitsuha-stars.mp4"

MANUAL_VIDEO_URLS = {
    # "bg-mitsuha-stars.mp4":        "",
    # "bg-rezero-scene.mp4":         "",
    # "bg-rezero-voice-ost.mp4":     "",
    # "bg-itadori-higurama.mp4":     "",
    # "bg-anime-scenery.mp4":        "",
}

# ──────────────────────────────────────────────────────────────────────────────

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov"}


def load_mapping():
    if MAPPING_FILE.exists():
        with open(MAPPING_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_mapping(mapping):
    with open(MAPPING_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
    print(f"  Mapeado guardado en {MAPPING_FILE.name}")


def upload_image_imgbb(api_key: str, file_path: Path) -> str:
    """Sube una imagen a imgbb.com y devuelve la URL directa."""
    with open(file_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    resp = requests.post(
        "https://api.imgbb.com/1/upload",
        data={"key": api_key, "image": b64, "name": file_path.stem},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"imgbb error: {data}")
    return data["data"]["url"]


def get_all_assets():
    images = []
    videos = []
    for f in sorted(ASSETS_DIR.iterdir()):
        if f.is_file():
            ext = f.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                images.append(f)
            elif ext in VIDEO_EXTENSIONS:
                videos.append(f)
    return images, videos


def update_html_files(mapping: dict):
    """Reemplaza referencias locales assets/X por URLs en todos los HTML."""
    html_dir = Path(__file__).parent
    replaced_total = 0

    for html_name in HTML_FILES:
        html_path = html_dir / html_name
        if not html_path.exists():
            continue

        content = html_path.read_text(encoding="utf-8")
        original = content

        for filename, url in mapping.items():
            if not url:
                continue
            # Reemplaza tanto "assets/nombre" como "assets/nombre%20con%20espacios"
            encoded_name = requests.utils.quote(filename, safe="")
            for pattern in [f"assets/{filename}", f"assets/{encoded_name}"]:
                if pattern in content:
                    content = content.replace(pattern, url)

        if content != original:
            html_path.write_text(content, encoding="utf-8")
            count = sum(
                content.count(url) for url in mapping.values() if url
            )
            print(f"  ✓ {html_name} actualizado")
            replaced_total += 1
        else:
            print(f"  – {html_name} sin cambios")

    return replaced_total


def main():
    parser = argparse.ArgumentParser(description="Sube assets del portfolio a la nube")
    parser.add_argument("--key", help="API key de imgbb.com (gratis en https://api.imgbb.com/)")
    parser.add_argument("--apply", action="store_true", help="Solo aplicar el mapping guardado a los HTML (sin subir)")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Omitir archivos ya subidos (default: True)")
    args = parser.parse_args()

    mapping = load_mapping()

    # Añadir videos manuales al mapping
    for vname, vurl in MANUAL_VIDEO_URLS.items():
        if vurl:
            mapping[vname] = vurl
            print(f"  Video manual: {vname} → {vurl}")

    if args.apply:
        print("\n=== Aplicando mapping a HTMLs ===")
        update_html_files(mapping)
        return

    if not args.key:
        print("\n" + "="*60)
        print("PASOS para subir tus assets:")
        print("="*60)
        print()
        print("1. IMÁGENES → imgbb.com (gratis, link directo)")
        print("   a) Ve a https://api.imgbb.com/ y regístrate gratis")
        print("   b) Copia tu API key")
        print("   c) Ejecuta: python upload_assets.py --key TU_API_KEY")
        print()
        print("2. VIDEOS → Cloudinary (gratis, tier: 25GB storage / 25GB bandwidth)")
        print("   a) Regístrate gratis en https://cloudinary.com/")
        print("   b) Sube cada video en el Dashboard → Media Library")
        print("   c) Haz clic derecho en el video → Copy URL (formato .mp4)")
        print("   d) Pega las URLs en MANUAL_VIDEO_URLS al inicio del script")
        print("   e) Ejecuta: python upload_assets.py --key TU_KEY")
        print()
        print("Videos a subir:")
        images, videos = get_all_assets()
        for v in videos:
            size_mb = v.stat().st_size / 1024 / 1024
            status = "✓ ya tiene URL" if mapping.get(v.name) else "✗ pendiente"
            print(f"   {status}  {v.name}  ({size_mb:.1f} MB)")
        print()
        print("Imágenes a subir:")
        for img in images:
            size_kb = img.stat().st_size / 1024
            status = "✓ ya tiene URL" if mapping.get(img.name) else "✗ pendiente"
            print(f"   {status}  {img.name}  ({size_kb:.0f} KB)")
        return

    # ── Subir imágenes ────────────────────────────────────────────────────────
    images, videos = get_all_assets()
    print(f"\n=== Subiendo {len(images)} imágenes a imgbb.com ===")

    for img in images:
        if args.skip_existing and mapping.get(img.name):
            print(f"  ⏭  {img.name} (ya subida)")
            continue

        size_kb = img.stat().st_size / 1024
        print(f"  ↑  {img.name} ({size_kb:.0f} KB)... ", end="", flush=True)
        try:
            url = upload_image_imgbb(args.key, img)
            mapping[img.name] = url
            save_mapping(mapping)
            print(f"OK → {url}")
            time.sleep(0.5)  # pequeña pausa para no spamear la API
        except Exception as e:
            print(f"ERROR: {e}")

    # ── Resumen de videos ─────────────────────────────────────────────────────
    pending_videos = [v for v in videos if not mapping.get(v.name)]
    if pending_videos:
        print(f"\n=== Videos pendientes de subir manualmente ({len(pending_videos)}) ===")
        for v in pending_videos:
            size_mb = v.stat().st_size / 1024 / 1024
            print(f"  ✗  {v.name}  ({size_mb:.1f} MB)")
        print()
        print("  Súbelos a Cloudinary y añade las URLs en MANUAL_VIDEO_URLS")
        print("  Luego vuelve a ejecutar el script.")
    else:
        print("\n=== Todos los videos tienen URL ✓ ===")

    # ── Actualizar HTMLs ──────────────────────────────────────────────────────
    all_done = all(mapping.get(f.name) for f in images + videos)
    if all_done:
        print("\n=== Actualizando HTML files ===")
        update_html_files(mapping)
        print("\n¡Listo! Puedes eliminar la carpeta assets/ del repo de GitHub.")
        print("Recuerda hacer commit solo de los HTML y CSS, sin assets/.")
    else:
        print("\nHTMLs no actualizados todavía (faltan URLs de videos).")
        print("Cuando tengas todas las URLs, ejecuta: python upload_assets.py --key TU_KEY")
        print("O solo aplica el mapping de imágenes con: python upload_assets.py --apply")


if __name__ == "__main__":
    main()
