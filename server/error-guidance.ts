export function errorGuidance(code:string) {
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
