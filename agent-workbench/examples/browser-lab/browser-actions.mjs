const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value,length) => typeof value === 'string' && !!value.trim() && value.length <= length;
export const roles = ['button','link','textbox','searchbox','checkbox','radio','combobox','listbox','option','tab','switch','heading','menuitem','spinbutton'];
const roleNames = new Set(roles);

export function browserUrl(value,base) {
  const url = new URL(value,base);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2_048) {
    throw new Error('仅允许不含账号、密码的 HTTP(S) 地址。');
  }
  return url;
}
function validLocator(value) {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  if (roleNames.has(value.role)) return keys.every(key=>['role','name'].includes(key)) &&
    (value.name === undefined || nonempty(value.name,160));
  return keys.length === 1 && ['label','testId','text'].includes(keys[0]) && nonempty(value[keys[0]],160);
}
const hasTarget = step => (step.selector === undefined && validLocator(step.locator)) ||
  (step.locator === undefined && nonempty(step.selector,300));
function locate(page,step) {
  if (step.selector !== undefined) return page.locator(step.selector);
  const {role,name,label,testId,text} = step.locator;
  if (role) return page.getByRole(role,name ? {name,exact:true} : {});
  if (label) return page.getByLabel(label,{exact:true});
  if (testId) return page.getByTestId(testId);
  return page.getByText(text,{exact:true});
}
const browserOptions = {timeout:4_000};
const definitions = {
  goto:{fields:['path'],sample:'{action:"goto",path:"…"}',valid:step=>nonempty(step.path,2048),
    async run({page,base,origins},step) {
      const url=browserUrl(step.path,base);
      if (!origins.has(url.origin)) throw new Error('跨来源导航被拒绝。');
      const response=await page.goto(url.href,{...browserOptions,waitUntil:'domcontentloaded'});
      if (!response || response.status()>=400) throw new Error('导航未成功：HTTP '+(response?.status()??'无响应'));
    }},
  fill:{fields:['value'],sample:'{action:"fill",locator:{label:"…"},value:"…"}',target:true,
    valid:step=>typeof step.value==='string'&&step.value.length<=500,
    run:({page},step)=>locate(page,step).fill(step.value,browserOptions)},
  click:{fields:[],sample:'{action:"click",locator:{role:"button",name:"…"}}',target:true,
    run:({page},step)=>locate(page,step).click(browserOptions)},
  expectText:{fields:['text'],sample:'{action:"expectText",locator:{testId:"…"},text:"…"}',target:true,valid:step=>nonempty(step.text,500),
    async run({page},step) {
      const actual=(await locate(page,step).innerText(browserOptions)).trim();
      if (actual!==step.text.trim()) throw new Error('断言不符：预期「'+step.text.slice(0,60)+'」，实际「'+actual.slice(0,60)+'」。');
    }},
  expectVisible:{fields:[],sample:'{action:"expectVisible",locator:{text:"…"}}',target:true,
    run:({page},step)=>locate(page,step).waitFor({...browserOptions,state:'visible'})},
  select:{fields:['label'],sample:'{action:"select",locator:{label:"…"},label:"选项文字"}',target:true,valid:step=>nonempty(step.label,160),
    run:({page},step)=>locate(page,step).selectOption({label:step.label},browserOptions)},
  check:{fields:['checked'],sample:'{action:"check",locator:{role:"checkbox",name:"…"},checked:true}',target:true,valid:step=>typeof step.checked==='boolean',
    run:({page},step)=>locate(page,step).setChecked(step.checked,browserOptions)},
  screenshot:{fields:[],sample:'{action:"screenshot"}',run:({capture})=>capture()}
};
export const browserActionNames = Object.keys(definitions);
export const browserPlanHelp = '格式为 {name,steps:[…]}，最多 15 步，首步必须 goto。可用动作：'+Object.values(definitions).map(item=>item.sample).join('、')+
  '。需要定位元素时可选 locator:{role,name}、{label}、{testId}、{text} 或 selector 字符串，只能选其一。匹配来自实际观察，名称和文本使用精确匹配。';
export function validateBrowserPlan(value) {
  if (!plain(value)||Object.keys(value).some(key=>!['name','steps'].includes(key))||!nonempty(value.name,100)||
      !Array.isArray(value.steps)||!value.steps.length||value.steps.length>15||value.steps[0]?.action!=='goto') {
    throw new Error('浏览器计划应有名称、以 goto 开始且最多 15 步。');
  }
  for (const step of value.steps) {
    const spec = plain(step)&&Object.hasOwn(definitions,step.action) ? definitions[step.action] : null;
    if (!spec || Object.keys(step).some(key=>key!=='action'&&!spec.fields.includes(key)&&!(spec.target&&['selector','locator'].includes(key))) ||
        spec.target&&!hasTarget(step) || spec.valid&&!spec.valid(step)) throw new Error('步骤动作或参数无效。');
  }
  return value;
}
export function executeBrowserStep(environment,step) { return definitions[step.action].run(environment,step); }
