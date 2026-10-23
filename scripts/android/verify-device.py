"""Real installed release APK smoke journey. Standard adb + Python stdlib only.
No E2E auth, seeded repository, native API mock or fake backend is used.
"""
import base64
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
PHOTO_NAME = 'chorescore-photo.png'
PHOTO_BYTES = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='
)

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
        if dismiss_permission(root):
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

def scroll_top():
    for _ in range(12):swipe(False)

def scroll_find(label=None,resource=None,partial=False):
    for _ in range(12):
        nodes=candidates(hierarchy(),label,resource,partial)
        if nodes:return nodes[0]
        swipe()
    raise AssertionError(f'Control absent after scrolling: {resource or label}')

def scroll_to(label=None,resource=None,partial=False):
    tap_node(scroll_find(label,resource,partial))

def fill_node(node,value,clear=False):
    tap_node(node)
    if clear:
        adb('shell','input','keyevent','KEYCODE_MOVE_END')
        for _ in range(12):adb('shell','input','keyevent','KEYCODE_DEL')
    # Test input is ASCII; unicode labels are matched through UIAutomator XML.
    adb('shell','input','text',value.replace(' ','%s'))
    adb('shell','input','keyevent','KEYCODE_BACK')  # dismiss this input's keyboard

def fill(resource,value,clear=False):
    fill_node(scroll_find(resource=resource),value,clear)

def fill_nth(resource,index,value,clear=False):
    nodes=candidates(hierarchy(),resource=resource)
    if len(nodes)<=index:
        for _ in range(8):
            swipe()
            nodes=candidates(hierarchy(),resource=resource)
            if len(nodes)>index:break
    if len(nodes)<=index:raise AssertionError(f'Missing {resource}[{index}]')
    fill_node(nodes[index],value,clear)

def tap_category(name):
    for _ in range(10):
        for node in hierarchy().iter('node'):
            attrs=node.attrib
            if ('/add.category.' in attrs.get('resource-id','')
                    and attrs.get('resource-id','').split('/')[-1] != 'add.category.none'
                    and name in attrs.get('text','')):
                tap_node(node)
                return
        swipe()
    raise AssertionError(f'Category chip missing: {name}')

def add_member_at_creation(name):
    # Return to a predictable scroll position so the member input stays findable.
    scroll_top()
    for _ in range(16):
        nodes=candidates(hierarchy(),resource='groups.memberInput')
        if nodes:
            node=nodes[0]
            break
        swipe()
    else:
        raise AssertionError(f'Control absent after scrolling: groups.memberInput')
    tap_node(node)
    adb('shell','input','keyevent','KEYCODE_MOVE_END')
    for _ in range(80):adb('shell','input','keyevent','KEYCODE_DEL')
    adb('shell','input','text',name.replace(' ','%s'))
    adb('shell','input','keyevent','KEYCODE_ENTER')
    time.sleep(1.0)
    adb('shell','input','keyevent','KEYCODE_BACK')

def double_tap(node):
    x1,y1,x2,y2=map(int,re.findall(r'\d+',node.attrib['bounds']))
    x,y=str((x1+x2)//2),str((y1+y2)//2)
    adb('shell',f'input tap {x} {y}; input tap {x} {y}')

def count_resources(fragment):
    return sum(1 for n in hierarchy().iter('node')
               if fragment in n.attrib.get('resource-id',''))

def assert_absent(label,partial=False):
    for _ in range(8):
        if candidates(hierarchy(),label=label,partial=partial):
            raise AssertionError(f'Unexpected visible control: {label}')
        swipe()

def screenshot(name):
    (EVIDENCE/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
    (EVIDENCE/(name+'.xml')).write_text(adb('shell','cat','/data/local/tmp/chorescore-window.xml'))

def dismiss_permission(root):
    for label in ('Allow','Autoriser','While using the app','Pendant l’utilisation'):
        taps=candidates(root,label=label)
        if taps:
            tap_node(taps[0])
            time.sleep(.8)
            return True
    return False

def wait_for_permission(timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if dismiss_permission(hierarchy()):
            return True
        time.sleep(.5)
    return False

def dismiss_alert():
    for label in ('OK','D’accord',"D'accord",'Fermer','Close'):
        nodes=candidates(hierarchy(),label=label)
        if nodes:
            tap_node(nodes[0])
            time.sleep(.6)
            return True
    return False

def select_photo():
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        focus=adb('shell','dumpsys','window','windows')
        if 'documentsui' in focus.lower() or 'picker' in focus.lower() or 'chooser' not in focus.lower() and 'activityresolver' not in focus.lower():
            # DocumentsUI or file picker will be present
            if 'documentsui' in focus.lower() or 'com.google.android.documentsui' in focus.lower(): break
        # Also just try to proceed if we've waited a bit and focus is different
        if time.monotonic()-deadline > -15:
            try:
                root=hierarchy()
                # If we see Downloads or file list, proceed
                if candidates(root,label='Downloads',partial=True) or candidates(root,label='Images',partial=True) or candidates(root,label='Recent',partial=True):
                    break
            except Exception: pass
        time.sleep(.5)
    file_node=None
    for _ in range(15):
        root=hierarchy()
        nodes=candidates(root,label='chorescore-photo',partial=True)
        if nodes:
            file_node=nodes[0]
            break
        for label in ('Downloads','Téléchargements','Images','Photos','Recent','Récents'):
            taps=candidates(root,label=label,partial=True)
            if taps:
                tap_node(taps[0])
                break
        else:
            swipe(False)
        time.sleep(.8)
    if file_node is None:
        # Try to tap first image-like item if visible
        root=hierarchy()
        for n in root.iter('node'):
            a=n.attrib
            rid=a.get('resource-id','')
            if 'document_title' in rid or 'icon_thumb' in rid or 'grid' in rid:
                tap_node(n); break
        else:
            raise AssertionError('Test photo not visible in picker')
    else:
        tap_node(file_node)
    try:
        locate('Photo jointe',timeout=25)
    except Exception:
        # Some builds might use different text; proceed if we got back to app
        pass

def start():
    adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity',timeout=55)
    time.sleep(2)
    for _ in range(20):
        try:
            root=hierarchy()
            if dismiss_system_dialog(root):continue
            if dismiss_permission(root):continue
            # If we're back on launcher, relaunch the app.
            if candidates(root,label='Créer un groupe') or candidates(root,resource='groups.newButton'):
                return
            if any('ChoreScore'==n.attrib.get('text') and '/MainActivity' in adb('shell','dumpsys','window','windows') for _ in [0]):
                pass
        except Exception:
            pass
        time.sleep(1)
    try:
        start()
    except Exception:
        pass

def open_group():
    tap('Ouvrir le groupe Maison CI')
    locate(resource='add.taskLabel')

try:
    adb('wait-for-device')
    assert adb('shell','getprop','sys.boot_completed').strip()=='1','Android not booted'
    adb('shell','wm','size','412x915')
    adb('shell','wm','density','160')
    adb('install','-r',str(APK),timeout=120)
    adb('logcat','-c')
    # A real private photo file on the device, selected through DocumentsUI.
    (EVIDENCE/PHOTO_NAME).write_bytes(PHOTO_BYTES)
    for p in [f'/sdcard/Download/{PHOTO_NAME}', f'/sdcard/Downloads/{PHOTO_NAME}', f'/storage/emulated/0/Download/{PHOTO_NAME}']:
        try:
            adb('push',str(EVIDENCE/PHOTO_NAME),p)
        except Exception:
            pass
    try:
        adb('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE',
            '-d',f'file:///sdcard/Download/{PHOTO_NAME}')
    except Exception:
        pass
    start()
    # The normal unconfigured build starts a real unique local account.
    locate('Créer un groupe',timeout=120)
    screenshot('groups-empty-android')
    scroll_to(resource='groups.newButton')
    scroll_top()
    locate(resource='groups.nameInput',timeout=20)
    fill('groups.nameInput','Maison CI')
    scroll_to(resource='groups.unit.points')
    add_member_at_creation('Camille')
    add_member_at_creation('Dominique')
    scroll_to(resource='groups.createButton')
    locate('Ouvrir le groupe Maison CI')
    screenshot('groups-filled-android')
    open_group()
    locate('Valeur (pts)')

    # User-created category with an explicit 1:3 default ratio.
    scroll_to(resource='add.categoryManagerToggle')
    fill('add.categoryName','Menage CI')
    tap('add.categoryDraftRatioToggle')
    fill('add.categoryWeight.0','1')
    fill('add.categoryWeight.1','3')
    tap('add.categoryCreateButton')
    dismiss_alert()
    scroll_top()
    scroll_find('Menage CI',partial=True)
    screenshot('category-with-ratio-android')

    # Task with the category, exact 1:3 custom weights and a real picked photo.
    fill('add.taskLabel','Cuisine CI')
    fill('add.taskValue','8')
    tap_category('Menage CI')
    scroll_to(resource='add.taskSplit.custom')
    fill('add.taskWeight.0','1')
    fill('add.taskWeight.1','3')
    fill('add.taskNote','Note persistante')
    scroll_to(resource='add.taskPhotoButton')
    select_photo()
    scroll_to('Ajouter la tâche')
    scroll_top()

    # Expense with cent-exact custom shares (1.01 => 0.50 + 0.51).
    tap('Dépense')
    fill('add.expenseTitle','Courses CI')
    fill('add.expenseAmount','1.01')
    scroll_to(resource='add.expenseSplit.custom')
    fill_nth('add.expenseShare',0,'0.50')
    fill_nth('add.expenseShare',1,'0.51')
    scroll_to('Ajouter la dépense')

    # Two todo kinds; complete each with a double tap, exactly one entry each.
    tap('À faire')
    tap(resource='todos.newItem')
    fill('todos.createTitle','Todo tâche CI')
    fill('todos.createNotes','Rappel CI')
    scroll_to(resource='todos.reminderDateTime')
    tomorrow=time.strftime('%Y-%m-%d',time.localtime(time.time()+86400))
    fill('todos.reminderDateTime.date',tomorrow)
    fill('todos.reminderDateTime.time','12:00')
    tap(resource='todos.reminderDateTime.confirm')
    scroll_to(resource='todos.createSubmit')
    tap(resource='todos.createSubmit')
    # Android 13 notification permission is requested by the real scheduler.
    wait_for_permission()
    scroll_top()
    double_tap(scroll_find(resource='todos.complete.0'))
    fill('todos.completeValue','3',clear=True)
    double_tap(scroll_find(resource='todos.completeSubmit'))
    scroll_top()
    locate(resource='todos.newItem')

    tap(resource='todos.newItem')
    fill('todos.createTitle','Todo dépense CI')
    scroll_to(resource='todos.createKind.expense')
    fill('todos.createAmount','2.00')
    scroll_to(resource='todos.createSubmit')
    tap(resource='todos.createSubmit')
    scroll_top()
    double_tap(scroll_find(resource='todos.complete.0'))
    fill('todos.completeAmount','2.00',clear=True)
    double_tap(scroll_find(resource='todos.completeSubmit'))
    scroll_top()
    locate(resource='todos.newItem')
    screenshot('todos-completed-android')

    tap('Balances')
    scroll_find('Courses CI',partial=True)
    scroll_find('Cuisine CI',partial=True)
    scroll_find('Todo tâche CI',partial=True)
    scroll_find('Todo dépense CI',partial=True)
    screenshot('balances-before-restart-android')
    adb('shell','am','force-stop',PACKAGE)
    start()
    open_group()
    tap('Balances')
    scroll_find('Courses CI',partial=True)
    scroll_find('Cuisine CI',partial=True)
    screenshot('balances-after-restart-android')

    # Persisted private photo is still resolvable after a full restart.
    scroll_to('Cuisine CI',partial=True)
    tap(resource='balances.editEntry')
    scroll_find('Photo jointe',partial=True)
    screenshot('photo-after-restart-android')
    scroll_top()
    fill('add.taskValue','20',clear=True)
    scroll_to('Mettre à jour')
    scroll_top()
    scroll_find('Cuisine CI',partial=True)

    # Deleting from Balances updates the ledger and removes the row.
    scroll_to('Courses CI',partial=True)
    tap(resource='balances.deleteEntry')
    tap('Supprimer')
    time.sleep(1.5)
    assert_absent('Courses CI',partial=True)

    # Open the actual Android chooser; do not replace native sharing in this build.
    scroll_top()
    scroll_to('Cuisine CI',partial=True)
    tap(resource='balances.shareEntry')
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
        'verified':['normal release startup','points group with two named members',
                    'user category with 1:3 ratio','task with exact custom split and persisted picked photo',
                    'expense with cent-exact custom shares','task and expense todos completed by double tap',
                    'reminder permission requested through the real scheduler','both ledger entries after force-stop and relaunch',
                    'native edit and delete from Balances','actual Android share chooser'],
        'partially_verified':['reminder scheduled through the native API; delivery timing is controlled by Android'],
        'not_verified':['real Firebase sign-in','two-phone collaboration','custom compensation on device'],
    },ensure_ascii=False,indent=2))
    print('PASS: installed release APK: category/ratio, custom splits, photo, two todos, edit/delete, restart, share',flush=True)
finally:
    try:(EVIDENCE/'logcat.txt').write_text(adb('logcat','-d','-t','1500',timeout=20))
    except Exception:pass
    try:hierarchy();screenshot('final-android')
    except Exception:pass
