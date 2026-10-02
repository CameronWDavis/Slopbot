"""Rebuild Bag Buddy in Blender 5.1. Run with --background --python this_file.

Asset authoring only: no application/runtime dependencies or project config changes.
"""
import bpy
import math
import json
import sys
from mathutils import Vector
from pathlib import Path

OUT = Path(__file__).resolve().parents[1]
PREVIEW = OUT / 'previews'
PREVIEW.mkdir(parents=True, exist_ok=True)
FPS = 30
TAU = math.tau
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
bpy.context.preferences.filepaths.save_version = 0
scene.render.fps = FPS
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 960
scene.render.resolution_y = 960
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.world.color = (.28, .28, .28)
scene.view_settings.view_transform = 'AgX'
scene.render.film_transparent = True

def material(name, rgb, roughness=.42, metallic=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metallic
    return m

bag = material('Charcoal satin bag', (.030, .027, .024), .43)
cream = material('Warm cream face', (.94, .87, .70), .42)
lime = material('Lime slime', (.49, .68, .075), .23)
wood = material('Paddle honey wood', (.53, .28, .10), .45)
edge = material('Paddle cream rim', (.83, .69, .44), .47)
coral = material('Ball soft coral', (.88, .23, .11), .36)
cordmat = material('Elastic charcoal', (.08, .065, .05), .65)

rig = []
meshes = []
def empty(name, loc=(0,0,0), parent=None):
    ob = bpy.data.objects.new(name, None)
    scene.collection.objects.link(ob)
    ob.location = loc
    ob.parent = parent
    rig.append(ob)
    return ob

root = empty('BagBuddy')
body = empty('Body', parent=root)
body['purpose'] = 'Squash, stretch and lean pivot; face and knot follow body'

def finish(ob, name, mat, parent):
    ob.name = name
    ob.parent = parent
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    meshes.append(ob)
    return ob

def sphere(name, loc, scale, mat, parent, segments=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    ob = finish(bpy.context.object, name, mat, parent)
    # Bake primitive scale into geometry so animation uses normalized node scales.
    for v in ob.data.vertices:
        v.co.x *= scale[0]
        v.co.y *= scale[1]
        v.co.z *= scale[2]
    return ob

def mesh_object(name, verts, faces, mat, parent):
    m = bpy.data.meshes.new(name)
    m.from_pydata(verts, [], faces)
    m.update()
    ob = bpy.data.objects.new(name, m)
    scene.collection.objects.link(ob)
    return finish(ob, name, mat, parent)

def tube(name, points, radius, mat, parent):
    c = bpy.data.curves.new(name, 'CURVE')
    c.dimensions = '3D'
    c.resolution_u = 2
    c.bevel_depth = radius
    c.bevel_resolution = 3
    s = c.splines.new('POLY')
    s.points.add(len(points)-1)
    for p, co in zip(s.points, points):
        p.co = (*co, 1)
    ob = bpy.data.objects.new(name, c)
    scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.convert(target='MESH')
    ob.select_set(False)
    return finish(ob, name, mat, parent)

# Smooth radial profile: broad bottom, tapered shoulders, cinched neck.
profile = [(0.14,.16),(.19,.57),(.30,.80),(.50,.91),(.78,.93),
           (1.06,.84),(1.34,.66),(1.60,.43),(1.80,.23),(1.93,.14)]
def radius_at(z):
    for i in range(len(profile)-1):
        if z <= profile[i+1][0]:
            p0 = profile[max(0,i-1)][1]
            p1,p2 = profile[i][1],profile[i+1][1]
            p3 = profile[min(len(profile)-1,i+2)][1]
            t = (z-profile[i][0])/(profile[i+1][0]-profile[i][0])
            return .5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
    return profile[-1][1]

verts=[]
faces=[]
N,M=64,40
for j in range(M+1):
    z=.14+(1.93-.14)*j/M
    r=radius_at(z)
    shoulder=max(0,(z-1.05)/.88)
    for i in range(N):
        a=TAU*i/N
        # Keep the front face quiet, with broader gathered folds at the neck.
        front=math.exp(-((math.atan2(math.sin(a+math.pi/2),math.cos(a+math.pi/2)))/.72)**2)
        folds=(.027*(1-front)*math.sin(7*a+z*2.8)
               +.048*shoulder*math.sin(11*a+z*1.8)
               +.019*math.sin(3*a+.9)*math.sin(math.pi*j/M))
        rr=r*(1+folds)
        verts.append((rr*math.cos(a)+.024*math.sin(z*2),rr*.76*math.sin(a),z))
for j in range(M):
    for i in range(N):
        a=j*N+i;b=j*N+(i+1)%N
        faces.append((a,b,b+N,a+N))
faces.append(tuple(reversed(range(N))))
faces.append(tuple(M*N+i for i in range(N)))
shell=mesh_object('Bag sculpt',verts,faces,bag,body)
sub=shell.modifiers.new('Soft bag surface','SUBSURF');sub.levels=1

# Flippers pivot at the shoulder, not their centers.
left=empty('Arm.L',(-.78,-.005,1.02),body)
right=empty('Arm.R',(.78,-.005,1.02),body)
al=sphere('Left mitten',(-.07,-.025,-.18),(.16,.17,.31),bag,left)
ar=sphere('Right mitten',(.07,-.025,-.18),(.16,.17,.31),bag,right)
al.rotation_euler.y=.30
ar.rotation_euler.y=-.30
foot_l=empty('Foot.L',(-.46,-.11,.13),root)
foot_r=empty('Foot.R',(.46,-.11,.13),root)
sphere('Left pebble foot',(0,0,0),(.25,.30,.13),bag,foot_l)
sphere('Right pebble foot',(0,0,0),(.25,.30,.13),bag,foot_r)

# Dot eyes are lightly raised off the bag, following its curved surface.
eye_l=empty('Eye.L',(-.285,-.655,1.04),body)
eye_r=empty('Eye.R',(.285,-.655,1.04),body)
el=sphere('Left cream eye',(0,0,0),(.086,.035,.086),cream,eye_l)
er=sphere('Right cream eye',(0,0,0),(.086,.035,.086),cream,eye_r)
el.rotation_euler.z=-.22
er.rotation_euler.z=.22
smile=empty('Smile',(0,-.722,.88),body)
points=[(.090*math.cos(math.pi+math.pi*i/24),0,.060*math.sin(math.pi+math.pi*i/24)) for i in range(25)]
tube('Cream smile',points,.014,cream,smile)
openmouth=empty('OpenMouth',(0,-.735,.875),body)
points=[(.063*math.cos(TAU*i/40),0,.087*math.sin(TAU*i/40)) for i in range(41)]
tube('Open mouth rim',points,.013,cream,openmouth)
openmouth.scale=(.001,)*3

knot=empty('Knot',(0,0,1.94),body)
for i in range(2):
    bpy.ops.mesh.primitive_torus_add(major_radius=.145,minor_radius=.055,major_segments=40,minor_segments=12,location=(0,0,.025+i*.085))
    ob=finish(bpy.context.object,f'Tied knot {i+1}',bag,knot)
    ob.scale=(1,.80,.72)
    ob.rotation_euler.y=.15*(-1 if i else 1)

# Two sculpted hollow-fold-like tied lobes, built as flattened closed lofts.
def tail(name, side, length, width, droop):
    vs=[];fs=[];nr=20;nc=16
    for j in range(nr+1):
        t=j/nr
        w=.030+width*math.sin(math.pi*t)**.55
        center=Vector((side*(.025+length*t),.014+.02*math.sin(t*math.pi),.12+.16*math.sin(t*math.pi*.70)-droop*t*t))
        for i in range(nc):
            a=TAU*i/nc
            vs.append(tuple(center+Vector((.10*w*math.cos(a),w*.68*math.sin(a),w*math.cos(a)*(1+.20*math.sin(3*a+t*2))))))
    for j in range(nr):
        for i in range(nc):
            a=j*nc+i;b=j*nc+(i+1)%nc
            fs.append((a,b,b+nc,a+nc))
    fs.extend([tuple(reversed(range(nc))),tuple(nr*nc+i for i in range(nc))])
    ob=mesh_object(name,vs,fs,bag,knot)
    sub=ob.modifiers.new('Fold softness','SUBSURF');sub.levels=1
tail('Large floppy tie',1,.55,.17,.22)
tail('Small floppy tie',-1,.29,.12,.09)
drop=empty('Slime',(.205,-.145,.015),knot)
sphere('Slime teardrop',(0,0,-.115),(.068,.055,.10),lime,drop)
sphere('Slime neck',(-.018,.009,-.038),(.035,.034,.065),lime,drop)

# Paddle, ball and elastic are part of the GLB, hidden by scale in other clips.
props=empty('PaddleProps',parent=root)
paddle=empty('Paddle', (1.17,-.27,.79),props)
sphere('Paddle blade',(0,0,.14),(.23,.055,.29),wood,paddle)
rim=tube('Paddle rim',[(.227*math.cos(TAU*i/64),-.014,.14+.285*math.sin(TAU*i/64)) for i in range(65)],.018,edge,paddle)
sphere('Paddle grip',(0,0,-.19),(.054,.052,.17),wood,paddle)
ball=empty('Ball',(1.55,-.35,1.4),props)
sphere('Rubber ball',(0,0,0),(.085,)*3,coral,ball)
cord=empty('Elastic',parent=props)
bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=.008,depth=1)
finish(bpy.context.object,'Elastic cord',cordmat,cord)
props.scale=(.001,)*3

baseline={o.name:(o.location.copy(),o.rotation_euler.copy(),o.scale.copy()) for o in rig}
def reset():
    for ob in rig:
        l,r,s=baseline[ob.name]
        ob.location=l;ob.rotation_euler=r;ob.scale=s

def blink(t, center, width=.07):
    return max(.075,1-.96*math.exp(-((t-center)/width)**4))

def pose(name,t,d):
    reset()
    p=t/d
    w=TAU*p
    breath=math.sin(w)
    body.scale=(1+.012*breath,1+.01*breath,1-.012*breath)
    knot.rotation_euler.y=.025*math.sin(w+.3)
    eye_l.scale.z=eye_r.scale.z=blink(p,.71,.022)
    if name=='thinking':
        body.rotation_euler.y=.10+.055*math.sin(w)
        right.rotation_euler.y=1.8+.1*math.sin(w*2)
        right.location=(.68,-.49,1.00)
        right.rotation_euler.x=-1.0
        eye_l.scale.z=.78;eye_r.scale.z=.85
        eye_l.location.z+=.015*math.sin(w);eye_r.location.z+=.015*math.sin(w)
        smile.scale=(.70,1,.6)
        knot.rotation_euler.y=.10*math.sin(w)
    elif name=='laughing':
        b=math.sin(w*4)
        body.scale=(1+.065*b,1+.035*b,1-.055*b)
        body.rotation_euler.y=.055*math.sin(w*2)
        eye_l.scale.z=eye_r.scale.z=.15
        smile.scale=(.001,)*3;openmouth.scale=(1.2,1,1+.22*b)
        left.rotation_euler.y=.55-.15*b;right.rotation_euler.y=-.55+.15*b
        knot.rotation_euler.y=.12*b
    elif name=='waving':
        env=math.sin(math.pi*p)**.55
        left.rotation_euler.y=env*(2.15+.30*math.sin(w*3))
        left.rotation_euler.x=.15*env
        body.rotation_euler.y=.06*env
    elif name=='celebrating':
        env=math.sin(math.pi*p)**2
        bounce=max(0,math.sin(w*2))
        root.location.z=.26*bounce*env
        body.scale=(1-.055*bounce,1-.04*bounce,1+.08*bounce)
        left.rotation_euler.y=2.4*env;right.rotation_euler.y=-2.4*env
        body.rotation_euler.z=.08*math.sin(w*2)*env
        smile.scale=(1.25,1,1.25)
    elif name=='sleeping':
        body.scale=(1.14+.015*breath,1.06,.78-.015*breath)
        eye_l.scale.z=eye_r.scale.z=.10
        smile.scale=(.70,1,.6)
        knot.rotation_euler.y=.20+.03*breath
        left.rotation_euler.y=-.18;right.rotation_euler.y=.18
    elif name=='curious':
        env=math.sin(math.pi*p)**2
        body.rotation_euler.y=-.20*env
        right.rotation_euler.y=-1.2*env
        smile.scale=(max(.001,1-env),)*3
        openmouth.scale=(max(.001,.55*env),)*3
        eye_l.scale=(1+.14*env,1,1+.14*env)
        eye_r.scale=(1+.14*env,1,1+.14*env)
    elif name=='oops':
        env=math.sin(math.pi*p)**2
        body.rotation_euler.y=.30*math.sin(w*2)*env
        body.location.x=.09*math.sin(w*2)*env
        left.rotation_euler.y=1.2*env;right.rotation_euler.y=-1.2*env
        knot.rotation_euler.y=-.30*math.sin(w*2)*env
        smile.scale=(max(.001,1-env),)*3
        openmouth.scale=(max(.001,env),)*3
        foot_l.rotation_euler.y=.25*env*math.sin(w*2)
        foot_r.rotation_euler.y=-.25*env*math.sin(w*2)
    elif name=='paddle_ball':
        props.scale=(1,1,1)
        q=TAU*t/1.2
        right.rotation_euler.y=-.70-.08*math.cos(q)
        right.rotation_euler.x=.12
        paddle.location=(1.0,-.24,.82+.055*math.cos(q))
        paddle.rotation_euler.x=math.pi/2-.10*math.cos(q)
        paddle.rotation_euler.y=.05*math.sin(q)
        body.rotation_euler.y=.035*math.sin(q)
        eye_l.location.z+=.025*(1-math.cos(q));eye_r.location.z+=.025*(1-math.cos(q))
        bpy.context.view_layer.update()
        anchor=paddle.matrix_local @ Vector((0,.067,.14))
        ball.location=anchor+Vector((.07*math.sin(q),-.035*math.sin(q),.085+.67*(1-math.cos(q))/2))
        delta=ball.location-anchor
        cord.location=(anchor+ball.location)/2
        cord.rotation_euler=delta.to_track_quat('Z','Y').to_euler()
        cord.scale=(1,1,delta.length)
        knot.rotation_euler.y=.06*math.sin(q-.5)

clips=[('idle',4.0,True),('thinking',3.2,True),('laughing',2.4,True),
       ('waving',2.0,False),('celebrating',2.4,False),('sleeping',4.0,True),
       ('curious',2.4,False),('oops',2.4,False),('paddle_ball',4.8,True)]

# Bake every animated node in every clip so transitions reset props and expressions.
for name,d,loop in clips:
    for ob in rig:
        ob.animation_data_create()
        ob.animation_data.action=None
    count=round(d*FPS)
    for frame in range(count+1):
        pose(name,frame/FPS,d)
        for ob in rig:
            for prop in ('location','rotation_euler','scale'):
                ob.keyframe_insert(data_path=prop,frame=frame+1,group=ob.name)
    for ob in rig:
        action=ob.animation_data.action
        action.name=f'{name}::{ob.name}'
        track=ob.animation_data.nla_tracks.new()
        track.name=name
        strip=track.strips.new(name,1,action)
        strip.action_slot=ob.animation_data.action_slot
        strip.extrapolation='NOTHING'
        track.mute=True
        ob.animation_data.action=None

def select_clip(name):
    for ob in rig:
        for track in ob.animation_data.nla_tracks:
            track.mute=track.name!=name
    scene.frame_start=1
    scene.frame_end=round(dict((n,d) for n,d,_ in clips)[name]*FPS)+1
    scene.frame_set(1)

select_clip('idle')
bpy.ops.object.select_all(action='DESELECT')
for ob in rig+meshes:
    ob.select_set(True)
bpy.context.view_layer.objects.active=root
bpy.ops.export_scene.gltf(filepath=str(OUT/'bag-buddy.glb'),export_format='GLB',
    use_selection=True,export_apply=True,export_animations=True,
    export_animation_mode='NLA_TRACKS',export_merge_animation='NLA_TRACK',
    export_frame_range=False,export_force_sampling=True,export_anim_slide_to_zero=True,
    export_optimize_animation_size=True,export_optimize_animation_keep_anim_object=True,
    export_extras=True,export_cameras=False,export_lights=False)

# Studio is kept in the .blend for reproducible previews, excluded from GLB.
def aim(ob,at):
    ob.rotation_euler=(Vector(at)-ob.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(3.2,-8.6,3.0))
camera=bpy.context.object
camera.name='Preview camera';camera.data.type='ORTHO';camera.data.ortho_scale=3.75
aim(camera,(.10,0,1.23));scene.camera=camera
for name,loc,power,size in [('Key',(-3,-4,6),650,5),('Fill',(4,-2,3),400,4),('Rim',(1,3,5),800,3)]:
    bpy.ops.object.light_add(type='AREA',location=loc)
    ob=bpy.context.object;ob.name=name;ob.data.energy=power;ob.data.shape='DISK';ob.data.size=size;aim(ob,(0,0,1))
select_clip('idle')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'bag-buddy.blend'))

manifest={
    'name':'Bag Buddy','version':'1.0.0','model':'bag-buddy.glb','source':'bag-buddy.blend',
    'poster':'previews/idle.png','format':'glTF 2.0','rig':'hierarchical transform animation',
    'coordinates':{'up':'+Y','forward':'+Z','groundY':0,'nominalHeight':2.5},
    'defaultClip':'idle','transitionSeconds':.22,
    'clips':[{'name':n,'durationSeconds':d,'loop':loop} for n,d,loop in clips],
    'behavior':{
        'thinking':{'clip':'thinking','priority':80,'interruptsBoredom':True},
        'working':{'clip':'thinking','priority':80,'interruptsBoredom':True},
        'greeting':{'clip':'waving','priority':40,'then':'idle'},
        'amused':{'clip':'laughing','priority':40,'maxLoops':2,'then':'idle'},
        'success':{'clip':'celebrating','priority':60,'then':'idle'},
        'surprised':{'clip':'curious','priority':40,'then':'idle'},
        'playful_mishap':{'clip':'oops','priority':30,'then':'idle'},
        'bored':{'clip':'paddle_ball','priority':10,'idleAfterSeconds':25,'maxLoops':3,'then':'idle'},
        'sleepy':{'clip':'sleeping','priority':5,'idleAfterSeconds':120},
        'idle':{'clip':'idle','priority':0}
    },
    'behaviorContract':{'implementedHere':False,'description':'Declarative hooks for the future web UI; assets do not run timers or execute tools.',
        'idleClock':'Time since last real user or agent activity; ambient animations do not reset it.',
        'resetOn':['user_input','agent_started','tool_started','agent_finished'],
        'reducedMotion':'Static idle pose at time zero; no automatic animation.',
        'hiddenTab':'Pause mixer and ambient timers; resume without catch-up.',
        'busy':'Suppress bored and sleepy states while an agent turn or tool is active.',
        'sound':'Silent; laughter is visual only.'}
}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

for name,frame in [('idle',1),('thinking',26),('laughing',11),('waving',31),('celebrating',23),('sleeping',1),('curious',37),('oops',24),('paddle_ball',19)]:
    if '--skip-stills' in sys.argv:
        break
    select_clip(name);scene.frame_set(frame)
    scene.render.filepath=str(PREVIEW/f'{name}.png')
    bpy.ops.render.render(write_still=True)
select_clip('idle')
scene.frame_set(1)
print('BAG_BUDDY_BUILD_COMPLETE',flush=True)
