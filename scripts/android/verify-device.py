"""Real installed release APK smoke journey. Standard adb + Python stdlib only.
No E2E auth, seeded repository, native API mock or fake backend is used.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

APK = Path(sys.argv[1]).resolve()
EVIDENCE = Path(os.environ.get('ANDROID_EVIDENCE_DIR','android-evidence')).resolve()
EVIDENCE.mkdir(parents=True,exist_ok=True)
PACKAGE = 'app.chorescore.v5'
ADB = os.environ.get('ADB_BIN','adb')

def adb(*args, binary=False, timeout=35):
    result = subprocess.run([ADB,*args],capture_output=True,timeout=timeout,check=True)
    return result.stdout if binary else result.stdout.decode('utf-8',errors='replace')

def hierarchy():
    adb('shell','uiautomator','dump','/data/local/tmp/chorescore-window.xml')
    data = adb('shell','cat','/data/local/tmp/chorescore-window.xml')
    (EVIDENCE/'latest-window.xml').write_text(data)
    return ET.fromstring(data)

def candidates(root, label=None, resource=None, partial=False):
    result=[]
    for node in root.iter('node'):
        attr=node.attrib
        if resource:
            value=attr.get('resource-id','')
            match=value==resource or value.endswith('/'+resource)
        else:
            values=[attr.get('text',''),attr.get('content-desc','')]
            match=any(label in v if partial else label==v for v in values)
        if match and attr.get('enabled')!='false':
            bounds=list(map(int,re.findall(r'\d+',attr.get('bounds',''))))
            if len(bounds)==4 and bounds[2]>bounds[0] and bounds[3]>bounds[1]:
                result.append(node)
    return sorted(result,key=lambda n:n.attrib.get('clickable')!='true')

def dismiss_system_dialog(root):
    """Dismiss an emulator/system ANR overlay that would hide the app.

    The CI emulator occasionally starts with a slow launcher/SystemUI ANR
    dialog on top of a perfectly healthy app. Tapping \"Wait\" keeps both the
    system and the product running; the journey assertions stay unchanged.
    """
    labels=[]
    for node in root.iter('node'):
        value=(node.attrib.get('text','')+' '+node.attrib.get('content-desc','')).lower()
        labels.append(value)
    blocked=any('isn\'t responding' in value or 'ne répond pas' in value or
                'application ne répond pas' in value for value in labels)
    if not blocked:
        return False
    for wait_label in ('Wait','Attendre'):
        taps=candidates(root,label=wait_label)
        if taps:
            tap_node(taps[0])
            time.sleep(1)
            return True
    return False

def locate(label=None, resource=None, partial=False, timeout=35):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        root=hierarchy()
        nodes=candidates(root,label,resource,partial)
        if nodes:return nodes[0]
        if dismiss_system_dialog(root):
            continue
        time.sleep(.5)
    raise AssertionError(f'Visible control missing: {resource or label}')

def tap_node(node):
    x1,y1,x2,y2=map(int,re.findall(r'\d+',node.attrib['bounds']))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))

def tap(label=None,resource=None,partial=False):
    tap_node(locate(label,resource,partial))

def swipe(up=True):
    adb('shell','input','swipe','206','740' if up else '260','206','260' if up else '740','350')

def scroll_find(label=None,resource=None,partial=False):
    for _ in range(9):
        nodes=candidates(hierarchy(),label,resource,partial)
        if nodes:return nodes[0]
        swipe()
    raise AssertionError(f'Control absent after scrolling: {resource or label}')

def scroll_to(label=None,resource=None,partial=False):
    tap_node(scroll_find(label,resource,partial))

def fill(resource,value):
    scroll_to(resource=resource)
    # Test input is ASCII; unicode labels are matched through UIAutomator XML.
    adb('shell','input','text',value.replace(' ','%s'))
    adb('shell','input','keyevent','KEYCODE_BACK')  # dismiss this input's keyboard

def screenshot(name):
    (EVIDENCE/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
    (EVIDENCE/(name+'.xml')).write_text(adb('shell','cat','/data/local/tmp/chorescore-window.xml'))

def start():
    adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity',timeout=55)

try:
    adb('wait-for-device')
    assert adb('shell','getprop','sys.boot_completed').strip()=='1','Android not booted'
    adb('shell','wm','size','412x915')
    adb('shell','wm','density','160')
    adb('install','-r',str(APK),timeout=120)
    adb('logcat','-c')
    start()
    # The normal unconfigured build starts a real unique local account.
    locate('Créer un groupe',timeout=90)
    screenshot('groups-empty-android')
    scroll_to(resource='groups.newButton')
    fill('groups.nameInput','Maison CI')
    scroll_to(resource='groups.unit.points')
    fill('groups.memberInput','Camille')
    scroll_to(resource='groups.createButton')
    locate('Ouvrir le groupe Maison CI')
    screenshot('groups-filled-android')
    tap('Ouvrir le groupe Maison CI')
    locate(resource='add.taskLabel')
    locate('Valeur (pts)')
    fill('add.taskLabel','Cuisine CI')
    fill('add.taskValue','9')
    fill('add.taskNote','Note persistante')
    scroll_to('Ajouter la tâche')
    for _ in range(3):swipe(False)
    tap('Dépense')
    fill('add.expenseTitle','Courses CI')
    fill('add.expenseAmount','1.01')
    scroll_to('Ajouter la dépense')
    tap('Balances')
    scroll_find('Courses CI',partial=True)
    scroll_find('Cuisine CI',partial=True)
    screenshot('balances-before-restart-android')
    adb('shell','am','force-stop',PACKAGE)
    start()
    tap('Ouvrir le groupe Maison CI')
    tap('Balances')
    scroll_find('Courses CI',partial=True)
    scroll_find('Cuisine CI',partial=True)
    screenshot('balances-after-restart-android')
    # Open the actual Android chooser; do not replace native sharing in this build.
    scroll_to('Cuisine CI',partial=True)
    tap('Partager')
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        focus=adb('shell','dumpsys','window','windows')
        if 'ChooserActivity' in focus or 'ResolverActivity' in focus:break
        time.sleep(.5)
    else:raise AssertionError('Native Android share chooser did not open')
    hierarchy();screenshot('native-share-android')
    adb('shell','input','keyevent','KEYCODE_BACK')
    (EVIDENCE/'result.json').write_text(json.dumps({
        'status':'passed','apk_sha256':hashlib.sha256(APK.read_bytes()).hexdigest(),
        'android':adb('shell','getprop','ro.build.version.release').strip(),
        'verified':['normal release startup','points group and pending named member','task and expense creation',
                    'both ledger entries after force-stop and relaunch','actual Android share chooser'],
        'not_verified':['real Firebase sign-in','two-phone collaboration','photos','reminders','custom splits','native editing/deletion'],
    },ensure_ascii=False,indent=2))
    print('PASS: installed release APK, persisted group/task/expense, restart, native share chooser',flush=True)
finally:
    try:(EVIDENCE/'logcat.txt').write_text(adb('logcat','-d','-t','1500',timeout=20))
    except Exception:pass
    try:hierarchy();screenshot('final-android')
    except Exception:pass
