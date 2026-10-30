const labels: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '处理中', SUCCEEDED: '已完成', COMPLETED: '已完成',
  FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断', PARTIAL: '部分完成',
  LIVE: '在线数据', LIVE_API: '在线数据', FIXTURE: '演示数据', MANUAL: '手动', SCHEDULE: '定时',
  REEVALUATION: '重新评估', KNOWN: '已结算', UNKNOWN: '未知', RESERVED: '已预留',
  NOT_RUN: '未执行', UNVERIFIED: '待验证', ANALYSIS: '问题分析', PATCH: '补丁生成',
  OPEN: '开放中', CLOSED: '已关闭', MERGED: '已合并', DRAFT: '草稿',
  WAITING_CONFIRMATION: '待确认', WAITING_SOURCE_CONFIRMATION: '待复核来源',
  ANALYSIS_QUEUED: '分析已排队', BLOCKED: '暂不可分析', ACTIVE: '可查看', IGNORED: '已忽略',
  DISABLED: '未开启', EVALUATED: '已评估', EVALUATION_FAILED: '评估失败',
  MODEL_NOT_CONFIGURED: '请先配置模型', MODEL_BUDGET_EXCEEDED: '模型额度已用完',
  BOUNDED_SEARCH_INCOMPLETE: '已完成本轮限定范围，结果可能不完整',
  CANCELLED_PARTIAL: '已取消，保留已获取结果', PARTIAL_EVALUATION: '部分评估已完成',
  DISCOVERY_NETWORK_FAILED: '网络连接失败，请检查网络后重试',
  SKIPPED_ACTIVE: '已有任务运行，本轮已跳过', SKIPPED_QUEUE_FULL: '队列已满，本轮已跳过',
  SKIPPED_UNAVAILABLE: '当前不可执行，已跳过', MISSED_SKIPPED: '错过计划时间，已跳过',
  RESTORE_BLOCKED: '数据恢复后暂时停用', SOURCE_BLOCKED: '来源当前不可用',
  SERVICE_STOPPED: '服务已停止', SCHEDULE_CHANGED: '定时设置已更新',
  SOURCE_RECHECK: '来源复核', EVALUATION_CANCELLED: '评估已取消',
  SNAPSHOT: '读取来源', CONTEXT: '整理上下文', MODEL: '模型分析',
  source: '读取来源', analysis: '模型分析',
  MODEL_PROVIDER_UNAVAILABLE: '模型服务返回异常', MODEL_PROVIDER_ERROR: '模型服务内部错误',
  MODEL_PROVIDER_GATEWAY_ERROR: '模型网关异常', MODEL_PROVIDER_OVERLOADED: '模型服务繁忙',
  MODEL_PROVIDER_GATEWAY_TIMEOUT: '模型网关超时',
};

export function display(value: string | null | undefined): string {
  if (!value) return '暂无';
  return labels[value] || value;
}
