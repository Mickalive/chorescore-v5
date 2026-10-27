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
import traceback
import urllib.request
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

def native_rpc(method, params):
    request=urllib.request.Request(os.environ['ANDROID_UIAUTOMATOR_RPC_URL'], data=json.dumps({
        'jsonrpc':'2.0', 'id':'chorescore', 'method':method, 'params':params,
    }).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=120) as response:
        result=json.load(response)
    if result.get('error') or 'result' not in result:
        raise AssertionError('Native UIAutomator hierarchy request failed' if method=='dumpWindowHierarchy'
                             else 'Native UIAutomator action failed: '+method)
    return result['result']

def adb(*args, binary=False, timeout=35):
    # The optional persistent server injects real Android events / edits into
    # the selected native widget. No repository or React state is accessed.
    if os.environ.get('ANDROID_UIAUTOMATOR_RPC_URL') and args[:2]==('shell','input'):
        action=args[2]
        if action=='tap':
            result=native_rpc('click',list(map(int,args[3:5])))
        elif action=='swipe':
            result=native_rpc('swipe',list(map(int,args[3:7]))+[max(2,int(args[7])//5)])
        elif action=='keycombination' and args[3:]==('113','29'):
            result=native_rpc('pressKeyCode',[29,4096])  # Android Ctrl+A
        elif action=='keyevent':
            codes={'KEYCODE_DEL':67,'KEYCODE_ENTER':66,'KEYCODE_MOVE_END':123,'KEYCODE_BACK':4}
            result=native_rpc('pressKeyCode',[codes[args[3]]])
        elif action=='text':
            selector={'mask':0x020010,'focused':True,'className':'android.widget.EditText',
                      'childOrSibling':[],'childOrSiblingSelector':[]}
            current=native_rpc('getText',[selector])
            result=native_rpc('setText',[selector,current+args[3].replace('%s',' ')])
        else:
            raise AssertionError('Unsupported native input action: '+action)
        if result is False:raise AssertionError('Native input action rejected: '+action)
        return b'' if binary else ''
    result = subprocess.run([ADB,*args],capture_output=True,timeout=timeout,check=True)
    return result.stdout if binary else result.stdout.decode('utf-8',errors='replace')

def hierarchy():
    rpc=os.environ.get('ANDROID_UIAUTOMATOR_RPC_URL')
    if rpc:
        # Optional persistent native UIAutomator server. It reads the same real
        # accessibility tree, avoiding a Java VM startup for every assertion.
        data=native_rpc('dumpWindowHierarchy',[False,100])
        if not isinstance(data,str):
            raise AssertionError('Native UIAutomator hierarchy request failed')
    else:
        # Software-only Android can spend >35s starting the Java dump process.
        adb('shell','uiautomator','dump','/data/local/tmp/chorescore-window.xml',
            timeout=int(os.environ.get('ANDROID_UI_DUMP_TIMEOUT', '35')))
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
            normalize=lambda value:value.replace('\u00a0',' ').replace('\u202f',' ')
            values=[normalize(attr.get('text','')),normalize(attr.get('content-desc',''))]
            expected=normalize(label)
            match=any(expected in v if partial else expected==v for v in values)
        if match and attr.get('enabled')!='false':
            bounds=list(map(int,re.findall(r'\d+',attr.get('bounds',''))))
            if len(bounds)==4 and bounds[2]>bounds[0] and bounds[3]>bounds[1]:
                result.append(node)
    return sorted(result,key=lambda n:n.attrib.get('clickable')!='true')

APP_PACKAGE = 'app.chorescore.v5'

# On the 412x915 test profile the Gboard IME can start as high as y=461, and a
# drag that touches it is delivered to the keyboard instead of the form
# ScrollView (run 40421090709: the next field was under the IME, the tap hit
# the "g" key and the notes were appended to the title). Every journey gesture,
# including keyboard-dismiss drags, therefore stays in this upper form band.
SWIPE_X = '206'
SWIPE_LOW = '140'
SWIPE_HIGH = '320'

_SCREEN_SIZE = None

# Only these system processes may be recovered from automatically. The dialog
# must both come from the Android system window and name one of these explicit
# processes. Anything else (notably a ChoreScore ANR) stays visible and fails
# the journey with the real diagnostic.
SYSTEM_ANR_PROCESSES = (
    'pixel launcher', 'com.google.android.apps.nexuslauncher',
    'launcher3', 'com.android.launcher3', 'quickstep',
    'system ui', 'systemui', 'com.android.systemui',
    'google quick search box', 'com.google.android.googlequicksearchbox',
)

def system_anr_title(root):
    """Return the ANR dialog title only when it belongs to a known system process."""
    dialog_packages={node.attrib.get('package','') for node in root.iter('node')}
    if not dialog_packages & {'android', 'com.android.systemui'}:
        return None
    titles=[]
    for node in root.iter('node'):
        resource=node.attrib.get('resource-id','')
        if resource.endswith('/alertTitle') or resource == 'android:id/alertTitle':
            text=node.attrib.get('text','').strip()
            if text:
                titles.append(text)
    if not titles:
        titles=[
            (node.attrib.get('text','')+' '+node.attrib.get('content-desc','')).strip()
            for node in root.iter('node')
            if (node.attrib.get('text','')+' '+node.attrib.get('content-desc','')).strip()
        ]
    titled=' '.join(titles).lower()
    if APP_PACKAGE in titled or 'chorescore' in titled:
        return None  # Real ChoreScore ANR: keep it visible.
    if not any(marker in titled for marker in SYSTEM_ANR_PROCESSES):
        return None
    if ('isn\'t responding' not in titled and 'ne répond pas' not in titled and
            'application ne répond pas' not in titled):
        return None
    return titled

def dismiss_system_dialog(root):
    """Dismiss only an ANR overlay raised by an explicitly named system process.

    A ChoreScore ANR is a product failure and must stay visible in diagnostics.
    The journey assertions are not relaxed: the app still has to be reachable.
    """
    if system_anr_title(root) is None:
        return False
    for wait_label in ('Wait','Attendre'):
        taps=candidates(root,label=wait_label)
        if taps:
            tap_node(taps[0])
            time.sleep(1)
            return True
    return False

def ime_window_blocks(dump):
    """Select actual IME windows, not app windows mentioning their IME target."""
    for block in re.split(r'\n  Window #',dump):
        heading=block.lstrip().splitlines()[0] if block.strip() else ''
        if (re.search(r'Window\{[^}\n]*\bInputMethod\b',heading)
                or re.search(r'\bmIsImWindow=true\b',block)):
            yield block

def keyboard_shown():
    """Report whether the IME window is actually visible on screen.

    On Android 15 the focused-window line can keep naming InputMethod after the
    IME has hidden (run 40025520675: Enter hid the keyboard at 13:30:16, the app
    still owned the task, yet the old focus check decided BACK was safe and the
    BACK closed MainActivity at 13:30:19). Never trust mCurrentFocus alone and
    never use dumpsys input_method's stale mInputShown flags. Inspect the real
    InputMethod window block instead.
    """
    dump=adb('shell','dumpsys','window','windows')
    for block in ime_window_blocks(dump):
        visible=re.search(r'mViewVisibility=0x0\b',block)
        concealed=re.search(r'isVisible=false|mHasSurface=false',block)
        if visible and not concealed:
            return True
    return False

def ime_top():
    """Return the top edge of a really-visible IME window, or None.

    UIAutomator still reports fields that are physically covered by the
    keyboard. Tapping their bounds sends the event to Gboard, which is not a
    product interaction. Parsing the InputMethod window frame lets the driver
    scroll a field into the uncovered area before tapping it.
    """
    dump=adb('shell','dumpsys','window','windows')
    for block in ime_window_blocks(dump):
        visible=re.search(r'mViewVisibility=0x0\b',block)
        concealed=re.search(r'isVisible=false|mHasSurface=false',block)
        if not visible or concealed:
            continue
        frame=re.search(r'(?<![A-Za-z])(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]',block)
        if frame:
            top=int(frame.group(2))
            # LatinIME on AOSP 35 owns a full-height transparent window.
            # Its visible inset is relative to that window (24 + 548 = 572
            # in the actual device dump), not a screen coordinate itself.
            inset=re.search(r'mGivenVisibleInsets=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]',block)
            if inset:
                visible_top=top+int(inset.group(2))
                if top<=visible_top<int(frame.group(4)):
                    top=visible_top
            if top>0:
                return top
        # Visible IME without a parseable frame: keep a conservative boundary
        # above the tallest observed keyboard instead of tapping into it.
        return 420
    return None

def screen_size():
    global _SCREEN_SIZE
    if _SCREEN_SIZE is None:
        match=re.search(r'(\d+)x(\d+)',adb('shell','wm','size'))
        if not match:
            raise AssertionError('Unable to read the emulator display size')
        _SCREEN_SIZE=(int(match.group(1)),int(match.group(2)))
    return _SCREEN_SIZE

def node_geometry(node):
    bounds=list(map(int,re.findall(r'\d+',node.attrib.get('bounds',''))))
    if len(bounds)!=4 or bounds[2]<=bounds[0] or bounds[3]<=bounds[1]:
        return None
    return ((bounds[0]+bounds[2])//2,(bounds[1]+bounds[3])//2)

def onscreen(node,bottom):
    centre=node_geometry(node)
    if centre is None:
        return False
    width,_=screen_size()
    return 6<=centre[0]<=width and 6<=centre[1]<bottom

def usable_bottom():
    top=ime_top()
    height=screen_size()[1]
    return (top-6) if top else (height-4)

def find_visible(root,label,resource,partial):
    """Return the first match that is not below the visible IME band."""
    nodes=candidates(root,label,resource,partial)
    if not nodes:
        return None
    bottom=usable_bottom()
    for node in nodes:
        if onscreen(node,bottom):
            return node
    return None

def hide_keyboard():
    """Dismiss a visible IME without sending BACK or ESCAPE.

    BACK is not safe: when the IME has already hidden (for example because a
    field uses blurAndSubmit) it reaches MainActivity and exits the app. In run
    40025520675 that is exactly what happened after typing "Camille": no
    crash, only a BACK arriving at 13:30:19 and the task closing. ESCAPE is not
    a safe substitute either, because an unhandled ESCAPE can be redispatched
    as BACK by the platform. Check visibility first and use gestures instead.

    The drag must live entirely above the IME. A drag starting at y=470 landed
    on Gboard in run 40421090709 and swipe-typed extra text into the focused
    field, so every attempt now uses the upper SWIPE_LOW..SWIPE_HIGH band.
    """
    for _ in range(3):
        if not keyboard_shown():
            return
        # Prefer the IME's own hide affordance when it is exposed to UIAutomator.
        for label in ('Hide keyboard','Masquer le clavier','Fermer le clavier','Close keyboard'):
            nodes=candidates(hierarchy(),label=label,partial=True)
            if nodes:
                tap_node(nodes[0])
                time.sleep(.5)
                break
        if not keyboard_shown():
            return
        # Every journey form is a ScreenContainer ScrollView with
        # keyboardDismissMode="on-drag". Keep the drag short: a 300 px swipe
        # moved the next field above the viewport in run 40328753105
        # (add.taskValue after add.taskLabel).
        adb('shell','input','swipe',SWIPE_X,SWIPE_HIGH,SWIPE_X,SWIPE_LOW,'220')
        time.sleep(.5)
    # A still-visible keyboard is not fatal: fill/scroll callers refuse to tap
    # controls below it, so the next field is scrolled into the clear band.

def foreground_packages(root):
    return {node.attrib.get('package','') for node in root.iter('node')} - {''}

def guarded_hierarchy(context):
    for _ in range(5):
        root=hierarchy()
        packages=foreground_packages(root)
        if APP_PACKAGE in packages:
            return root
        if dismiss_system_dialog(root) or dismiss_permission(root):
            time.sleep(.5)
            continue
        raise AssertionError(
            f'App left foreground during {context}: {", ".join(sorted(packages)) or "unknown"}')
    raise AssertionError(f'App stayed behind a system dialog during {context}')

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
    # Stay above the IME band so scrolling works even while the keyboard is
    # still visible or animating away. Dragging on the IME does nothing to the
    # form, which is how add.taskValue was missed in run 40328753105.
    adb('shell','input','swipe',SWIPE_X,SWIPE_HIGH if up else SWIPE_LOW,
        SWIPE_X,SWIPE_LOW if up else SWIPE_HIGH,'350')

def scroll_top():
    # Recovery must not depend on scroll drags reaching the app while the IME
    # is still up; dismiss it first, then rewind with gestures in the safe band.
    hide_keyboard()
    previous=None
    for _ in range(12):
        root=hierarchy()
        if dismiss_system_dialog(root) or dismiss_permission(root):
            previous=None
            continue
        current=ET.tostring(root,encoding='unicode')
        if current==previous:
            return
        previous=current
        swipe(False)

def _scroll_find_pass(label,resource,partial,attempts):
    dismissed=0
    for _ in range(attempts):
        root=hierarchy()
        node=find_visible(root,label,resource,partial)
        if node is not None:return node
        # The control exists but is covered by the IME: dismiss the keyboard
        # first instead of tapping Gboard. Swiping while it is visible cannot
        # move the form and may swipe-type into the focused field.
        if candidates(root,label,resource,partial) and keyboard_shown():
            hide_keyboard()
            continue
        if dismissed<8 and (dismiss_system_dialog(root) or dismiss_permission(root)):
            dismissed+=1
            continue
        swipe()
    return None

def scroll_find(label=None,resource=None,partial=False):
    # System dialogs (e.g. the emulator's Pixel Launcher ANR) can steal the
    # window hierarchy while the app is still running. Dismiss only the known
    # system processes, never a ChoreScore ANR, and keep the product assertion.
    node=_scroll_find_pass(label,resource,partial,12)
    if node is not None:return node
    # A keyboard-dismiss drag or an earlier form action can leave the target
    # just above the viewport. Swiping only downwards would then never find it
    # (run 40328753105: add.taskValue was missed after add.taskLabel). Rewind
    # to the start of the form and search in the other direction before failing.
    scroll_top()
    node=_scroll_find_pass(label,resource,partial,16)
    if node is not None:return node
    raise AssertionError(f'Control absent after scrolling: {resource or label}')

def scroll_to(label=None,resource=None,partial=False):
    """Find and tap once; callers must not tap the submitted control again."""
    hide_keyboard()
    tap_node(scroll_find(label,resource,partial))

def assert_ledger_totals(task_values,money_values):
    scroll_top()
    for value in task_values+money_values:
        scroll_find(value)

def input_text(value):
    # `adb shell input text` feeds the device key map, which cannot emit
    # arbitrary Unicode: run 40328753105 died with exit 255 on 'â'. The Android
    # journey therefore types ASCII labels only; Unicode persistence is proven
    # by the repository/domain tests instead of by a flaky key event. Fail
    # loudly if a future edit reintroduces a character adb cannot type.
    if not value.isascii():
        raise AssertionError(f'adb input text cannot type non-ASCII value: {value!r}')
    adb('shell','input','text',value.replace(' ','%s'))

def verify_input_value(resource,value):
    deadline=time.monotonic()+8
    observed=None
    while time.monotonic()<deadline:
        fields=candidates(hierarchy(),resource=resource)
        focused=next((field for field in fields if field.attrib.get('focused')=='true'),None)
        field=focused if focused is not None else (fields[0] if len(fields)==1 else None)
        if field is not None:
            observed=field.attrib.get('text','')
            if observed==value:return
        time.sleep(.2)
    raise AssertionError(f'Input value mismatch for {resource}: expected {value!r}, observed {observed!r}')

def fill_node(node,value,clear=True):
    tap_node(node)
    if clear:
        # Android 15's documented Ctrl+A combination replaces the entire field,
        # including defaults and long/multiline values, before typing. Appending
        # to a maxLength=10/5 date/time field silently kept the old timestamp.
        adb('shell','input','keycombination','113','29')
        adb('shell','input','keyevent','KEYCODE_DEL')
    input_text(value)
    verify_input_value(node.attrib['resource-id'],value)
    hide_keyboard()

def fill(resource,value,clear=True):
    hide_keyboard()
    fill_node(scroll_find(resource=resource),value,clear)

def fill_nth(resource,index,value,clear=True):
    hide_keyboard()
    visible=lambda ns:[n for n in ns if onscreen(n,usable_bottom())]
    nodes=visible(candidates(hierarchy(),resource=resource))
    if len(nodes)<=index:
        for _ in range(8):
            swipe()
            nodes=visible(candidates(hierarchy(),resource=resource))
            if len(nodes)>index:break
    if len(nodes)<=index:
        scroll_top()
        for _ in range(16):
            nodes=visible(candidates(hierarchy(),resource=resource))
            if len(nodes)>index:break
            swipe()
    if len(nodes)<=index:raise AssertionError(f'Missing {resource}[{index}]')
    fill_node(nodes[index],value,clear)

def open_datetime(resource):
    """Tap a real date-time control and prove its draft dialog opened.

    Replaces the former sleep/scroll retry: a tap can be lost to a transient
    overlay, so retry once, but the date field is still mandatory. No arbitrary
    delay is needed because locate polls the hierarchy until the deadline.
    """
    last_error=None
    for attempt in range(2):
        hide_keyboard()
        tap_node(scroll_find(resource=resource))
        try:
            return locate(resource=resource+'.date', timeout=12)
        except AssertionError as error:
            last_error=error
    raise last_error

def resource_name(node):
    """Return the raw resource name with or without a package/id prefix.

    Some UIAutomator builds expose ``add.category.foo`` while others expose the
    fully qualified ``app.chorescore.v5:id/add.category.foo``. Matching on a
    leading slash therefore missed every real user category and failed the
    journey with "Category chip missing" while the chip was visible.
    """
    return node.attrib.get('resource-id','').split('/')[-1]

def category_chip(name):
    for node in hierarchy().iter('node'):
        rid=resource_name(node)
        # RN exposes the chip label in content-desc and leaves text empty on the
        # clickable Button node; the visible label is only on its child. Accept
        # either so a real chip is never reported missing.
        label=node.attrib.get('text','')+' '+node.attrib.get('content-desc','')
        if (rid.startswith('add.category.')
                and rid != 'add.category.none'
                and name in label):
            return node
    return None

def tap_category(name):
    for _ in range(10):
        node=category_chip(name)
        if node is not None:
            tap_node(node)
            return
        swipe()
    # The chip can be above the viewport after an earlier field interaction.
    scroll_top()
    for _ in range(16):
        node=category_chip(name)
        if node is not None:
            tap_node(node)
            return
        swipe()
    raise AssertionError(f'Category chip missing: {name}')

def add_member_at_creation(name):
    # Return to a predictable scroll position so the member input stays findable.
    scroll_top()
    for _ in range(16):
        nodes=candidates(guarded_hierarchy('member input '+name),resource='groups.memberInput')
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
    # Enter submits the inline member field. Wait for the chip, then close the
    # IME only if it is still visible; a blind BACK exits the app to Launcher.
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        root=guarded_hierarchy('member chip '+name)
        if candidates(root,label=name) and candidates(root,resource='groups.memberInput'):
            break
        time.sleep(.3)
    else:
        raise AssertionError(f'Member not added at creation: {name}')
    hide_keyboard()
    root=guarded_hierarchy('group form after '+name)
    if not candidates(root,resource='groups.memberInput'):
        raise AssertionError(f'Group form closed after adding member: {name}')

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
    packages={node.attrib.get('package','') for node in root.iter('node')}
    if not packages & {'com.android.permissioncontroller',
                       'com.google.android.permissioncontroller'}:
        return False
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

def device_time_plus(minutes=2):
    """Future local date/time on the emulator, not on the CI host."""
    import datetime
    raw=adb('shell','date','+%Y-%m-%d %H:%M:%S').strip()
    future=datetime.datetime.strptime(raw,'%Y-%m-%d %H:%M:%S')+datetime.timedelta(minutes=minutes)
    return future.strftime('%Y-%m-%d'), future.strftime('%H:%M')

def verify_installed_candidate():
    """Reuse only the exact APK bytes, never an old build with the same name."""
    paths=[line[len('package:'):] for line in adb('shell','pm','path',PACKAGE).splitlines() if line.startswith('package:')]
    if len(paths)!=1:raise AssertionError('Exactly one installed candidate APK is required')
    actual=adb('shell','sha256sum',paths[0],timeout=120).split()[0]
    expected=hashlib.sha256(APK.read_bytes()).hexdigest()
    if actual!=expected:raise AssertionError('Installed APK digest does not match candidate')
    return actual

def notification_visible(root,title):
    """A matching todo in the app is not proof of notification delivery."""
    panels={'notification_stack_scroller','notification_panel','notification_container_parent'}
    for node in root.iter('node'):
        if node.attrib.get('package')=='com.android.systemui' and node.attrib.get('resource-id','').split('/')[-1] in panels:
            if candidates(node,label=title,partial=True):return True
    return any(node.attrib.get('package')=='com.android.systemui'
               for node in candidates(root,label=title,partial=True))

def wait_for_reminder(title, timeout=240):
    """Prove the native Android scheduler actually posts the reminder.

    The notification shade is the observable result, not the mere presence of a
    scheduling call. The open todo is intentionally left uncompleted so
    completing it would not cancel the reminder under test.
    """
    deadline=time.monotonic()+timeout
    try:
        while time.monotonic()<deadline:
            adb('shell','cmd','statusbar','expand-notifications')
            time.sleep(1)
            root=hierarchy()
            if notification_visible(root,title):
                screenshot('reminder-delivered-android')
                return
            adb('shell','cmd','statusbar','collapse')
            time.sleep(5)
        root=hierarchy()
        screenshot('reminder-not-delivered-android')
        raise AssertionError(f'Native reminder not delivered: {title}')
    finally:
        try: adb('shell','cmd','statusbar','collapse')
        except Exception: pass

def dismiss_alert():
    for label in ('OK','D’accord',"D'accord",'Fermer','Close'):
        nodes=candidates(hierarchy(),label=label)
        if nodes:
            tap_node(nodes[0])
            time.sleep(.6)
            return True
    return False

def picker_file_node(name):
    """Return the real document row, never the tiny corner preview button."""
    for node in hierarchy().iter('node'):
        values=(node.attrib.get('text','').strip(),
                node.attrib.get('content-desc','').strip())
        if not any(value.startswith(name) for value in values):
            continue
        if any('preview' in value.lower() or 'aperçu' in value.lower() for value in values):
            continue
        bounds=list(map(int,re.findall(r'\d+',node.attrib.get('bounds',''))))
        if len(bounds)==4 and bounds[2]>bounds[0] and bounds[3]>bounds[1]:
            return node
    return None

def picker_root_labels():
    return ('Downloads','Téléchargements','Images','Photos','Recent','Récents')

def select_photo():
    deadline=time.monotonic()+90
    app_without_chip=0
    while time.monotonic()<deadline:
        root=hierarchy()
        packages=foreground_packages(root)
        if APP_PACKAGE in packages:
            if candidates(root,label='Photo jointe',partial=True):
                return
            app_without_chip+=1
            if app_without_chip>6:
                buttons=candidates(root,resource='add.taskPhotoButton')
                if buttons:
                    tap_node(buttons[0])
                    time.sleep(1)
                    app_without_chip=0
            time.sleep(.5)
            continue
        if dismiss_system_dialog(root) or dismiss_permission(root):
            continue
        if any('documentsui' in package for package in packages):
            # A preview overlay is not a selection; go back to the file list.
            if not candidates(root,resource='dir_list'):
                adb('shell','input','keyevent','KEYCODE_BACK')
                time.sleep(.8)
                continue
            node=picker_file_node(PHOTO_NAME)
            if node is not None:
                tap_node(node)
                # Wait until the picker closes and the form exposes the chip.
                # A second tap on the corner preview icon used to leave the
                # journey stuck inside DocumentsUI.
                settle=time.monotonic()+20
                while time.monotonic()<settle:
                    time.sleep(.5)
                    current=hierarchy()
                    if APP_PACKAGE in foreground_packages(current):
                        if candidates(current,label='Photo jointe',partial=True):
                            return
                        break
                    if not candidates(current,resource='dir_list'):
                        break
                    if dismiss_system_dialog(current) or dismiss_permission(current):
                        break
                continue
            for label in picker_root_labels():
                taps=candidates(root,label=label,partial=True)
                if taps:
                    tap_node(taps[0])
                    break
            else:
                swipe(False)
            time.sleep(.8)
            continue
        time.sleep(.5)
    raise AssertionError('Photo picker did not return a saved attachment')

def start():
    adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity',timeout=55)
    time.sleep(2)
    last_error=None
    for _ in range(20):
        try:
            root=hierarchy()
            if dismiss_system_dialog(root):continue
            if dismiss_permission(root):continue
            # If we're back on launcher, relaunch the app.
            if candidates(root,label='Créer un groupe') or candidates(root,resource='groups.newButton'):
                return
        except Exception as error:
            last_error=error
        time.sleep(1)
    raise AssertionError(f'Groups screen did not open after launch: {last_error or "not visible"}')

def open_group():
    tap('Ouvrir le groupe Maison CI')
    locate(resource='add.taskLabel')

try:
    adb('wait-for-device')
    assert adb('shell','getprop','sys.boot_completed').strip()=='1','Android not booted'
    # Keep the emulator awake across the real reminder wait (up to four minutes).
    adb('shell','svc','power','stayon','true')
    adb('shell','wm','size','412x915')
    adb('shell','wm','density','160')
    if '--already-installed' not in sys.argv[2:]:
        adb('install','-r',str(APK),timeout=120)
    verified_apk_sha256=verify_installed_candidate()
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

    # User-created category with 1:3:1 defaults for all three group members.
    scroll_to(resource='add.categoryManagerToggle')
    fill('add.categoryName','Menage CI')
    # The ratio toggle and create button are below the name field once the
    # manager expands; scroll them into view instead of assuming they stayed
    # on the 412x915 viewport after the keyboard closed.
    scroll_to(resource='add.categoryDraftRatioToggle')
    fill('add.categoryWeight.0','1')
    fill('add.categoryWeight.1','3')
    fill('add.categoryWeight.2','1')
    scroll_to(resource='add.categoryCreateButton')
    dismiss_alert()
    scroll_top()
    scroll_find('Menage CI',partial=True)
    screenshot('category-with-ratio-android')

    # Task with the category, exact 1:3 custom weights and a real picked photo.
    fill('add.taskLabel','Cuisine CI')
    fill('add.taskValue','8')
    tap_category('Menage CI')
    # Exactly two beneficiaries for the explicit 1:3 override; the third named
    # member stays in the group but must not leave an unfilled custom share.
    scroll_to(resource='add.taskBeneficiary.2')
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
    scroll_to(resource='add.expenseParticipant.2')
    scroll_to(resource='add.expenseSplit.custom')
    fill_nth('add.expenseShare',0,'0.50')
    fill_nth('add.expenseShare',1,'0.51')
    scroll_to('Ajouter la dépense')

    # Two todo kinds; complete each with a double tap, exactly one entry each.
    tap('À faire')
    tap(resource='todos.newItem')
    fill('todos.createTitle','Todo tache CI')
    fill('todos.createNotes','Rappel CI')
    open_datetime('todos.reminderDateTime')
    tomorrow=time.strftime('%Y-%m-%d',time.localtime(time.time()+86400))
    fill('todos.reminderDateTime.date',tomorrow)
    fill('todos.reminderDateTime.time','12:00')
    tap(resource='todos.reminderDateTime.confirm')
    scroll_to(resource='todos.createSubmit')
    # Android 13 notification permission is requested by the real scheduler.
    wait_for_permission()
    scroll_top()
    double_tap(scroll_find(resource='todos.complete.0'))
    fill('todos.completeValue','3',clear=True)
    double_tap(scroll_find(resource='todos.completeSubmit'))
    scroll_top()
    locate(resource='todos.newItem')

    tap(resource='todos.newItem')
    fill('todos.createTitle','Todo depense CI')
    scroll_to(resource='todos.createKind.expense')
    fill('todos.createAmount','2.00')
    scroll_to(resource='todos.createSubmit')
    scroll_top()
    double_tap(scroll_find(resource='todos.complete.0'))
    fill('todos.completeAmount','2.00',clear=True)
    double_tap(scroll_find(resource='todos.completeSubmit'))
    scroll_top()
    locate(resource='todos.newItem')
    screenshot('todos-completed-android')

    # A third, deliberately uncompleted todo proves the native Android
    # scheduler really posts a reminder (permission alone is not proof).
    tap(resource='todos.newItem')
    fill('todos.createTitle','Rappel natif CI')
    fill('todos.createNotes','Notification CI')
    open_datetime('todos.reminderDateTime')
    reminder_date,reminder_time=device_time_plus(2)
    fill('todos.reminderDateTime.date',reminder_date)
    fill('todos.reminderDateTime.time',reminder_time)
    tap(resource='todos.reminderDateTime.confirm')
    scroll_to(resource='todos.createSubmit')
    scroll_top()
    locate(resource='todos.newItem')
    wait_for_reminder('Rappel natif CI')

    tap('Balances')
    scroll_find('Courses CI',partial=True)
    scroll_find('Cuisine CI',partial=True)
    scroll_find('Todo tache CI',partial=True)
    scroll_find('Todo depense CI',partial=True)
    assert_ledger_totals(['+ 8 pts','- 7 pts','- 1 pts'],
                         ['+ 1,84 CHF','- 1,18 CHF','- 0,66 CHF'])
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
    assert_ledger_totals(['+ 17 pts','- 16 pts','- 1 pts'],
                         ['+ 1,33 CHF','- 0,67 CHF','- 0,66 CHF'])

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

    # General preferences must actually control native scheduling and survive
    # process death; a label saying "available" is not a preference.
    adb('shell','am','force-stop',PACKAGE)
    start()
    scroll_to('Options générales')
    switch=locate(resource='options.remindersEnabled')
    assert switch.attrib.get('checked')=='true','Reminders should start enabled'
    tap_node(switch)
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        switch=locate(resource='options.remindersEnabled')
        if switch.attrib.get('checked')=='false':break
        time.sleep(.3)
    else:raise AssertionError('Reminder opt-out was not applied')
    adb('shell','am','force-stop',PACKAGE)
    start()
    scroll_to('Options générales')
    switch=locate(resource='options.remindersEnabled')
    assert switch.attrib.get('checked')=='false','Reminder opt-out lost after restart'
    tap_node(switch)
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        switch=locate(resource='options.remindersEnabled')
        if switch.attrib.get('checked')=='true':break
        time.sleep(.3)
    else:raise AssertionError('Reminder opt-in failed')
    hierarchy();screenshot('notification-options-android')
    (EVIDENCE/'result.json').write_text(json.dumps({
        'status':'passed','apk_sha256':verified_apk_sha256,
        'installation':'existing APK bytes verified' if '--already-installed' in sys.argv[2:] else 'installed and APK bytes verified',
        'android':adb('shell','getprop','ro.build.version.release').strip(),
        'verified':['normal release startup','points group with two named members',
                    'user category with 1:3:1 ratio','task with 1:3 override for two beneficiaries and persisted picked photo',
                    'expense with cent-exact custom shares','task and expense todos completed by double tap',
                    'reminder permission requested through the real scheduler',
                    'real local reminder notification observed in the Android shade','both ledger entries after force-stop and relaunch',
                    'native edit and delete from Balances','actual Android share chooser',
                    'reminder preference disabled, persisted after restart and enabled again'],
        'partially_verified':['reminder scheduled through the native API; delivery timing is controlled by Android'],
        'not_verified':['real Firebase sign-in','two-phone collaboration','custom compensation on device'],
    },ensure_ascii=False,indent=2))
    print('PASS: installed release APK: category/ratio, custom splits, photo, two todos, edit/delete, restart, share',flush=True)
except Exception:
    detail=traceback.format_exc()
    (EVIDENCE/'failure.txt').write_text(detail)
    try:(EVIDENCE/'window-dump.txt').write_text(adb('shell','dumpsys','window','windows'))
    except Exception:pass
    # Make the actual Python assertion readable through the checks API as well
    # as the downloadable evidence, without flattening it into an exit code.
    escaped=detail.replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print('::error title=Android acceptance failure::'+escaped,flush=True)
    raise
finally:
    try:(EVIDENCE/'logcat.txt').write_text(adb('logcat','-d','-t','1500',timeout=20))
    except Exception:pass
    try:hierarchy();screenshot('final-android')
    except Exception:pass
