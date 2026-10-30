export function errorGuidance(code:string) {
  if(/DISCOVERY_COST_CONFIRMATION/.test(code))return {category:'COST_CONFIRMATION',message:'请先明确确认模型费用。',nextAction:'开启评估会作用于后续手动与定时发现；确认后再保存，或保持关闭使用规则候选。'};
  if(/DISCOVERY_PROFILE_REQUIRED|INVALID_DISCOVERY_PROFILE|DISCOVERY_HARD_LIMIT/.test(code))return {category:'PROFILE',message:'画像尚未保存或字段不符合边界。',nextAction:'填写至少一种语言，检查 Star 范围和资源限额，保存后再发现。'};
  if(/SOURCE_|CANDIDATE_EXCLUDED/.test(code))return {category:'SOURCE_RECHECK',message:'来源需要重新复核，或已被关闭、忽略或排除。',nextAction:'打开机会发现中的候选，重新复核并核对风险；关闭来源不能开始付费分析。'};
  const match=(pattern:RegExp)=>pattern.test(code);
  if(match(/NOT_CONFIGURED|INVALID_MODEL_IDENTIFIER|INVALID_SETTINGS/)) return {category:'CONFIGURATION',message:'模型或密钥引用尚不可用。',nextAction:'核对已保存的模型和服务端环境变量，修改环境变量后重启服务。'};
  if(match(/REVISION|CONFLICT|BUSY|ALREADY_ACTIVE|NOT_READY/)) return {category:'CONFLICT',message:'配置或执行状态已变化。',nextAction:'刷新当前配置；已有业务任务完成后，再主动发起测试。'};
  if(match(/RESTORE_BLOCKED/)) return {category:'RESTORE',message:'恢复数据库后，当日连接测试暂停。',nextAction:'等待下个 UTC 日；恢复前后费用以供应商账单为准。'};
  if(match(/BUDGET|COOLDOWN|QUOTA|STORAGE_LIMIT|QUEUE_LIMIT/)) return {category:'LIMIT',message:'本地预算、间隔或存储限额不足。',nextAction:'查看限额与重置时间，勿通过重复创建任务绕过预算。'};
  if(match(/AUTH|PERMISSION/)) return {category:'CREDENTIALS',message:'远端凭据或访问权限未通过。',nextAction:'核对供应商账号、密钥权限与模型授权。'};
  if(match(/RATE|CREDIT/)) return {category:'PROVIDER_LIMIT',message:'供应商限制了请求或账号额度。',nextAction:'检查账号额度和限流；此提示不代表已查询实际余额。'};
  if(match(/JSON|OUTPUT|EVIDENCE|SECRET_ECHO/)) return {category:'VALIDATION',message:'模型输出未通过校验。',nextAction:'核对配置或缩小计划范围。重新调用可能增加费用，已有结果保留。'};
  if(match(/PATCH|DIFF|PATH|PLAN/)) return {category:'PATCH_SCOPE',message:'计划或 Diff 格式、范围不符合约束。',nextAction:'仅修改已获取且允许的普通文本路径；保存并确认新计划后再生成。'};
  return {category:'REQUEST',message:'请求未完成。',nextAction:'检查服务端联网及远端状态。用量未知时可能已计费，不会自动重试。'};
}
