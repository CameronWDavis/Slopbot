"""Inspect the actual GLB, including animation payloads; no extra packages needed."""
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
raw = (ROOT/'bag-buddy.glb').read_bytes()
magic, version, length = struct.unpack_from('<4sII', raw)
assert magic == b'glTF' and version == 2 and length == len(raw)
pos = 12
chunks = {}
while pos < len(raw):
    n, tag = struct.unpack_from('<I4s', raw, pos)
    chunks[tag] = raw[pos+8:pos+8+n]
    pos += 8+n
g = json.loads(chunks[b'JSON'])
binary = chunks[b'BIN\x00']
assert not any(b.get('uri') for b in g.get('buffers', [])), 'External buffers'
assert not g.get('images'), 'Unexpected texture dependency'
assert not g.get('extensionsRequired'), 'Unexpected required extension'

formats = {5120:('b',1),5121:('B',1),5122:('h',2),5123:('H',2),5125:('I',4),5126:('f',4)}
components = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def data(index):
    a=g['accessors'][index]
    view=g['bufferViews'][a['bufferView']]
    typ, size=formats[a['componentType']]
    count=components[a['type']]
    step=view.get('byteStride',size*count)
    offset=view.get('byteOffset',0)+a.get('byteOffset',0)
    assert offset+(a['count']-1)*step+size*count <= len(binary)
    rows=[struct.unpack_from('<'+typ*count,binary,offset+i*step) for i in range(a['count'])]
    assert all(math.isfinite(v) for row in rows for v in row)
    return rows

triangles=0
for mesh in g['meshes']:
    for primitive in mesh['primitives']:
        points=data(primitive['attributes']['POSITION'])
        indices=data(primitive['indices'])
        assert all(0 <= row[0] < len(points) for row in indices)
        assert primitive.get('mode',4)==4 and len(indices)%3==0
        triangles+=len(indices)//3

manifest=json.loads((ROOT/'manifest.json').read_text())
expected={x['name']:x for x in manifest['clips']}
actual={a['name']:a for a in g['animations']}
assert len(actual)==len(g['animations']) and actual.keys()==expected.keys()
report=[]
targets=None
for name,a in actual.items():
    channels={(c['target']['node'],c['target']['path']) for c in a['channels']}
    assert len(channels)==len(a['channels']), 'Duplicate animation channel'
    if targets is None: targets=channels
    assert targets==channels, f'{name}: missing reset channels'
    end=0
    for c in a['channels']:
        s=a['samplers'][c['sampler']]
        times=[x[0] for x in data(s['input'])]
        values=data(s['output'])
        assert times[0]==0 and all(x<y for x,y in zip(times,times[1:]))
        assert len(times)==len(values) and s.get('interpolation','LINEAR') in ('LINEAR','STEP')
        end=max(end,times[-1])
        if c['target']['path']=='rotation':
            assert all(abs(sum(v*v for v in q)-1)<.001 for q in values)
        if expected[name]['loop']:
            error=max(abs(x-y) for x,y in zip(values[0],values[-1]))
            if c['target']['path']=='rotation':
                error=min(error,max(abs(x+y) for x,y in zip(values[0],values[-1])))
            assert error<.002, f'{name}: loop seam on {c["target"]}'
    assert abs(end-expected[name]['durationSeconds'])<.001
    report.append({'name':name,'durationSeconds':round(end,3),'channels':len(channels),'loopSeamChecked':expected[name]['loop']})

# Props must appear only in paddle play. Check actual animated scale data.
propnode=next(i for i,n in enumerate(g['nodes']) if n.get('name')=='PaddleProps')
for name,a in actual.items():
    channel=next(c for c in a['channels'] if c['target']=={'node':propnode,'path':'scale'})
    values=data(a['samplers'][channel['sampler']]['output'])
    assert all(max(row)>.99 if name=='paddle_ball' else max(row)<.002 for row in values)

result={'passed':True,'glbBytes':len(raw),'triangles':triangles,'meshes':len(g['meshes']),
        'nodes':len(g['nodes']),'materials':len(g['materials']),'selfContained':True,
        'checks':['GLB structure','finite geometry','triangle indices','named clips and durations',
                  'matching reset channels','unit quaternions','loop endpoint continuity','prop visibility'],
        'clips':report}
(ROOT/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
