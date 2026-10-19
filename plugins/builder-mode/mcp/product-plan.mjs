import { randomUUID, createHash } from 'node:crypto';
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function line(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1200) throw new Error(`${name} requires a concise explanation`);
  return value.trim();
}
function lines(value, name, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > 5) throw new Error(`${name} requires ${min}-5 points`);
  return value.map(item=>line(item,name));
}
function currentProject(store, args) {
  const project = store.getProject(args.projectId ?? 'main');
  if (!project || project.stateRevision !== args.expectedStateRevision) throw new Error('Stale project state; reread before updating the product plan');
  return project;
}
export function planStatus(store, project) {
  const events=store.listOwnerEvents(project.id).filter(e=>e.goalRevision===project.goalRevision);
  const proposal=events.filter(e=>e.kind==='update' && e.payload.recordType==='product_plan').at(-1);
  if (!proposal) return { status:'not_discussed', authorizationGranted:false };
  const response=events.filter(e=>e.kind==='update' && e.payload.recordType==='plan_response' && e.payload.planId===proposal.id).at(-1);
  return { status:response?.payload.response==='accept'?'aligned':response?.payload.response==='revise'?'needs_revision':'awaiting_response',
    planId:proposal.id, planDigest:proposal.payload.planDigest, plan:proposal.payload.plan,
    response:response?.payload ?? null, attestation:response?'assistant_attributed':'none', authorizationGranted:false };
}
export function requireAlignedPlan(store, project) {
  const state=planStatus(store,project);
  if(state.status!=='aligned') throw new Error('PLAN_ALIGNMENT_REQUIRED: 先用日常语言对齐第一版方案；选择某个AI服务或提供凭据不等于认可整个方案。');
  return state;
}
export function requireTaskPlan(store, project, task) {
  const aligned=requireAlignedPlan(store,project);
  if(task.input?.planId!==aligned.planId || task.input?.planDigest!==aligned.planDigest) throw new Error('This result belongs to an older product plan; verify a new change for the current plan');
  return aligned;
}
export function proposePlan(args,{withStore}) {
  return withStore(args.workspacePath,store=>{
    const project=currentProject(store,args);
    const plan={};
    for(const key of ['userOutcome','whereYouWillUseIt','nextCheckpoint'])plan[key]=line(args[key],key);
    for(const key of ['firstVersion','notIncluded','steps'])plan[key]=lines(args[key],key);
    plan.openChoices=lines(args.openChoices ?? [],'openChoices',0);
    const previous=planStatus(store,project);
    if(previous.planDigest===hash(plan)) return {message:'这份方案与已保存的方案一致，无需重复创建或确认。',data:{...previous,stateRevision:project.stateRevision}};
    if(store.listRecoverableAttempts(project.id).some(a=>a.writer)) throw new Error('先由负责人核对并收尾已开始的工作，再替换方案；新想法可先讨论记录，不要让用户重置状态。');
    const payload={recordType:'product_plan',plan,planDigest:hash(plan),attribution:'assistant_proposed',authorizationGranted:false};
    const id=store.recordOwnerEvent({id:`plan-${randomUUID()}`,projectId:project.id,kind:'update',payload});
    return {message:'第一版方案已整理，尚未开始制作。先请用户看懂、调整或认可；服务选择不能代替这个回应。',
      data:{planId:id,planDigest:payload.planDigest,stateRevision:store.getProject(project.id).stateRevision,plan,status:'awaiting_response'}};
  });
}
export function recordPlanResponse(args,{withStore}) {
  return withStore(args.workspacePath,store=>{
    const project=currentProject(store,args), state=planStatus(store,project);
    if(args.responseTo!=='product_plan') throw new Error('Only a response to the product plan can align it; a service choice cannot');
    if(!state.planId || typeof args.planId!=='string' || state.planId!==args.planId || state.planDigest!==args.planDigest) throw new Error('The response must refer to the latest plan for this goal');
    if(!['accept','revise','discuss'].includes(args.response)) throw new Error('Unsupported plan response');
    if(state.status==='aligned' && args.response!=='accept' && store.listRecoverableAttempts(project.id).some(a=>a.writer)) throw new Error('先由负责人核对并收尾已开始的工作，再修改当前方案；用户的新反馈先记录为待处理事项，不要重置或伪造认可。');
    if(args.response==='accept' && state.plan.openChoices.length) throw new Error('Resolve material open choices in the plan before recording agreement');
    const payload={recordType:'plan_response',planId:state.planId,planDigest:state.planDigest,response:args.response,
      userQuote:line(args.userQuote,'actual user plan response'),sourceRef:line(args.sourceRef,'user message reference'),
      attestation:'assistant_attributed',authorizationGranted:false};
    const id=store.recordOwnerEvent({id:`plan-response-${randomUUID()}`,projectId:project.id,kind:'update',payload});
    return {message:args.response==='accept'?'已记录对首版方案的认可，可继续既定范围内制作；费用、上传和发布权限仍需单独核对。':'已记录需要继续讨论或修改，尚未放行制作。',
      data:{id,stateRevision:store.getProject(project.id).stateRevision,...planStatus(store,store.getProject(project.id))}};
  });
}
