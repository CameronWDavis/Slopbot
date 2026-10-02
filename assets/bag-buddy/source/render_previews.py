"""Render the exported GLB after a clean import, not the authoring scene.

blender --background --factory-startup --python render_previews.py -- --frames /tmp/bag-buddy-frames
Then use encode_previews.py with the same frame directory.
"""
import bpy
import json
import argparse
import sys
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--frames',type=Path,required=True)
parser.add_argument('--only',choices=['thinking','laughing','paddle_ball'])
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
args.frames.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.render.fps=30
bpy.ops.import_scene.gltf(filepath=str(ROOT/'bag-buddy.glb'))
scene=bpy.context.scene
scene.render.fps=30
objects=list(scene.objects)
tracks={}
for ob in objects:
    if ob.animation_data:
        ob.animation_data.action=None
        for tr in ob.animation_data.nla_tracks:
            tracks.setdefault(tr.name,[]).append((ob,tr))
print('IMPORTED_CLIPS',sorted(tracks),flush=True)
expected=json.loads((ROOT/'manifest.json').read_text())['clips']
assert set(tracks)=={c['name'] for c in expected}, 'Missing imported clips'

def select(name,frame):
    for clip,pairs in tracks.items():
        for ob,tr in pairs:
            tr.mute=clip!=name
    scene.frame_set(frame)

scene.render.engine='CYCLES'
scene.cycles.samples=32
scene.cycles.use_denoising=True
scene.render.resolution_x=896
scene.render.resolution_y=896
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=True
scene.world.color=(.28,)*3
scene.view_settings.view_transform='AgX'
def aim(ob,at):
    ob.rotation_euler=(Vector(at)-ob.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.5,-8.6,3.0))
camera=bpy.context.object
camera.data.type='ORTHO';camera.data.ortho_scale=3.6
aim(camera,(.15,0,1.20));scene.camera=camera
for loc,power,size in [((-3,-4,6),650,5),((4,-2,3),400,4),((1,3,5),800,3)]:
    bpy.ops.object.light_add(type='AREA',location=loc)
    ob=bpy.context.object;ob.data.energy=power;ob.data.shape='DISK';ob.data.size=size;aim(ob,(0,0,1))
for name,frame in [('idle',1),('thinking',26),('laughing',11),('waving',31),('celebrating',23),('sleeping',1),('curious',37),('oops',24),('paddle_ball',19)]:
    if args.only and name!=args.only:
        continue
    select(name,frame)
    scene.render.filepath=str(ROOT/'previews'/f'{name}.png')
    bpy.ops.render.render(write_still=True)

# A studio floor gives opaque animation formats a clean background and shadow.
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.008))
floor=bpy.context.object
mat=bpy.data.materials.new('Preview warm paper')
mat.diffuse_color=(.84,.79,.71,1)
mat.use_nodes=True
shader=mat.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value=(.84,.79,.71,1)
shader.inputs['Roughness'].default_value=.85
floor.data.materials.append(mat)
scene.render.film_transparent=False
scene.render.resolution_x=384
scene.render.resolution_y=384
scene.cycles.samples=12
index=[]
for name,duration in [('thinking',3.2),('laughing',2.4),('paddle_ball',4.8)]:
    if args.only and name!=args.only:
        continue
    directory=args.frames/name
    directory.mkdir(exist_ok=True)
    frame_count=round(duration*15)
    for i in range(frame_count):
        # Imported animation starts at frame 0, matching GLB time zero.
        select(name,i*2)
        scene.render.filepath=str(directory/f'{i:04d}.png')
        bpy.ops.render.render(write_still=True)
    index.append({'name':name,'fps':15,'frames':frame_count,'directory':str(directory)})
(args.frames/'index.json').write_text(json.dumps(index,indent=2)+'\n')
print('GLB_ROUNDTRIP_PREVIEWS_COMPLETE',flush=True)
