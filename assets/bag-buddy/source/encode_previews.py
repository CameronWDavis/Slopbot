"""Encode Blender-rendered frames to animated WebP/GIF. Requires Pillow."""
import json
import sys
from pathlib import Path
from PIL import Image

root=Path(__file__).resolve().parents[1]
index=json.loads((Path(sys.argv[1])/'index.json').read_text())
for clip in index:
    images=[Image.open(Path(clip['directory'])/f'{i:04d}.png').convert('RGB') for i in range(clip['frames'])]
    durations=[round((i+1)*1000/clip['fps'])-round(i*1000/clip['fps']) for i in range(len(images))]
    images[0].save(root/'previews'/f'{clip["name"]}.webp',save_all=True,append_images=images[1:],duration=durations,loop=0,quality=88)
    # GIF timing is in 10ms units. Alternate 60/70ms to preserve exact duration.
    gifdur=[10*(round((i+1)*100/clip['fps'])-round(i*100/clip['fps'])) for i in range(len(images))]
    images[0].save(root/'previews'/f'{clip["name"]}.gif',save_all=True,append_images=images[1:],duration=gifdur,loop=0,disposal=2)
    print(clip['name'],len(images),'frames')
