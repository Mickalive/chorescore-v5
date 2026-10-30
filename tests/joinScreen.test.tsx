import React from 'react';
import renderer, { act } from 'react-test-renderer';
import JoinScreen from '../app/join/[token]';
import { Button } from '../src/ui/components/Button';

let mockToken: string | string[]='A'.repeat(43);
const mockApp=jest.fn();
const mockRouter={replace:jest.fn()};
const mockTranslate=(key:string) => key;
jest.mock('../src/features/app/AppContext',()=>({useApp:()=>mockApp()}));
jest.mock('../src/i18n',()=>({useI18n:()=>({t:mockTranslate})}));
jest.mock('expo-router',()=>({useLocalSearchParams:()=>({token:mockToken}),useRouter:()=>mockRouter}));
jest.mock('react-native-safe-area-context',()=>({SafeAreaView:({children}:any)=>children}));

function state() {
  return {isLoading:false,currentUser:null as any,households:[],loadHouseholds:jest.fn(async()=>{}),
    setCurrentHouseholdId:jest.fn(),signInWithProvider:jest.fn(async()=>false),
    services:{sync:{isAvailable:()=>true,acceptInvitation:jest.fn(async(_token:string)=>({groupId:'joined-group',memberId:'existing-member'}))}}};
}
function button(tree:renderer.ReactTestRenderer,title:string) {
  return tree.root.findAllByType(Button).find(node=>node.props.title===title)!;
}
beforeEach(()=>{mockToken='A'.repeat(43);mockRouter.replace.mockReset();});

test('cold invitation stays on its route through Google sign-in and opens the accepted group',async()=>{
  const app=state();mockApp.mockReturnValue(app);
  let tree!:renderer.ReactTestRenderer;
  await act(async()=>{tree=renderer.create(<JoinScreen/>);});
  app.signInWithProvider.mockImplementation(async()=>{
    mockApp.mockReturnValue({...app,currentUser:{userId:'google-b'}});
    tree.update(<JoinScreen/>);
    return true;
  });
  await act(async()=>button(tree,'auth.continueGoogle').props.onPress());
  expect(app.signInWithProvider).toHaveBeenCalledWith('google');
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(app.services.sync.acceptInvitation).not.toHaveBeenCalled();
  await act(async()=>button(tree,'join.accept').props.onPress());
  expect(app.services.sync.acceptInvitation).toHaveBeenCalledWith('A'.repeat(43));
  expect(app.loadHouseholds).toHaveBeenCalledWith('google-b');
  await act(async()=>button(tree,'join.goToGroup').props.onPress());
  expect(app.setCurrentHouseholdId).toHaveBeenCalledWith('joined-group');
  expect(mockRouter.replace).toHaveBeenCalledWith('/add');
  await act(async()=>tree.unmount());
});

test('auth restoration waits without falsely reporting unavailable collaboration',async()=>{
  const app=state();mockApp.mockReturnValue({...app,isLoading:true,services:{sync:{isAvailable:()=>false}}});
  let tree!:renderer.ReactTestRenderer;
  await act(async()=>{tree=renderer.create(<JoinScreen/>);});
  expect(JSON.stringify(tree.toJSON())).toContain('join.verifying');
  expect(JSON.stringify(tree.toJSON())).not.toContain('invite.unavailableBody');
  mockApp.mockReturnValue({...app,currentUser:{userId:'restored-user'}});
  await act(async()=>tree.update(<JoinScreen/>));
  expect(button(tree,'join.accept')).toBeDefined();
  await act(async()=>tree.unmount());
});

test('acceptance waits for Google account activation even after the auth listener has emitted a user',async()=>{
  const app=state();mockApp.mockReturnValue(app);
  let tree!:renderer.ReactTestRenderer;
  let finish!:(value:boolean)=>void;
  app.signInWithProvider.mockImplementation(()=>{
    mockApp.mockReturnValue({...app,currentUser:{userId:'google-b'}});
    tree.update(<JoinScreen/>);
    return new Promise(resolve=>{finish=resolve;});
  });
  await act(async()=>{tree=renderer.create(<JoinScreen/>);});
  await act(async()=>{void button(tree,'auth.continueGoogle').props.onPress();});
  const pending=button(tree,'state.loading');
  expect(pending.props.disabled).toBe(true);
  await act(async()=>pending.props.onPress());
  expect(app.services.sync.acceptInvitation).not.toHaveBeenCalled();
  await act(async()=>finish(true));
  expect(button(tree,'join.accept').props.disabled).toBeFalsy();
  await act(async()=>tree.unmount());
});

test('double accept sends one request and an old response never accepts a newly opened link',async()=>{
  const app=state();mockApp.mockReturnValue({...app,currentUser:{userId:'google-b'}});
  let finish!:(value:{groupId:string;memberId:string})=>void;
  app.services.sync.acceptInvitation.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  let tree!:renderer.ReactTestRenderer;
  await act(async()=>{tree=renderer.create(<JoinScreen/>);});
  const accept=button(tree,'join.accept').props.onPress;
  await act(async()=>{void accept();void accept();});
  expect(app.services.sync.acceptInvitation).toHaveBeenCalledTimes(1);
  mockToken='B'.repeat(43);
  await act(async()=>tree.update(<JoinScreen/>));
  await act(async()=>finish({groupId:'old-group',memberId:'old-member'}));
  expect(JSON.stringify(tree.toJSON())).not.toContain('join.accepted');
  expect(button(tree,'join.accept')).toBeDefined();
  expect(mockRouter.replace).not.toHaveBeenCalled();
  await act(async()=>tree.unmount());
});

test('cancelled Google sign-in preserves the invitation and invalid tokens never reach the authority',async()=>{
  const app=state();mockApp.mockReturnValue(app);
  let tree!:renderer.ReactTestRenderer;
  await act(async()=>{tree=renderer.create(<JoinScreen/>);});
  await act(async()=>button(tree,'auth.continueGoogle').props.onPress());
  expect(button(tree,'auth.continueGoogle').props.disabled).toBeFalsy();
  expect(mockRouter.replace).not.toHaveBeenCalled();
  mockToken=['A'.repeat(43),'B'.repeat(43)];
  mockApp.mockReturnValue({...app,currentUser:{userId:'google-b'}});
  await act(async()=>tree.update(<JoinScreen/>));
  expect(JSON.stringify(tree.toJSON())).toContain('join.invalidLink');
  expect(app.services.sync.acceptInvitation).not.toHaveBeenCalled();
  await act(async()=>tree.unmount());
});
