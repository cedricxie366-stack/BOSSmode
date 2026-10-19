// Existing regression suites test post-alignment mechanics. Explicitly seed
// synthetic plan approval in their fixture; intake tests use the raw tool.
import { callBuilderTool } from '../mcp/server.mjs';
export async function callAlignedFixture(name,args) {
  const result=await callBuilderTool(name,args);
  if(name!=='builder_open_project' || result.isError) return result;
  if(result.data.productPlan?.status==='aligned') return result;
  const base={workspacePath:args.workspacePath,...(args.projectId?{projectId:args.projectId}:{})};
  const plan=await callBuilderTool('builder_propose_plan',{...base,expectedStateRevision:result.data.stateRevision,
    userOutcome:'内部合成回归样例，不是真实用户方案',whereYouWillUseIt:'独立本地测试目录',firstVersion:['验证当前测试所要求的行为'],notIncluded:['真实服务、付费、外发及用户体验认证'],
    steps:['准备合成成果','检查结果'],nextCheckpoint:'可核对的测试结果'});
  await callBuilderTool('builder_record_plan_response',{...base,expectedStateRevision:plan.data.stateRevision,planId:plan.data.planId,planDigest:plan.data.planDigest,
    responseTo:'product_plan',response:'accept',userQuote:'合成测试回应：按这份回归样例方案实施。',sourceRef:'automated-test-fixture-not-real-user'});
  return callBuilderTool('builder_get_project',base);
}
