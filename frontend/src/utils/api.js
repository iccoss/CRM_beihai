import request from '@/utils/request';

// 按销售统计各状态商机数量（开周会页面）
export function getWeeklyMeetingOpportunitiesByStatus(params) {
  return request({
    url: '/api/stats/weekly-meeting/opportunities-by-status',
    method: 'get',
    params
  });
}

// 按销售统计合同数量和待回款数量（开周会页面）
export function getWeeklyMeetingContractsAndPayments(params) {
  return request({
    url: '/api/stats/weekly-meeting/contracts-and-payments',
    method: 'get',
    params
  });
}

// 每位销售在所选周期（季度/年度）与上一周期的进展对比（开周会页面）
export function getWeeklyMeetingWeeklyProgress(params) {
  return request({
    url: '/api/stats/weekly-meeting/weekly-progress',
    method: 'get',
    params
  });
}

// 获取可筛选的商机列表（开周会页面）
export function getWeeklyMeetingFilterableOpportunities(params) {
  return request({
    url: '/api/stats/weekly-meeting/filterable-opportunities',
    method: 'get',
    params
  });
}

// 根据商机ID获取跟进记录
export function getFollowupsByOpportunity(opportunityId) {
  return request({
    url: `/api/followups/by-opportunity/${opportunityId}`,
    method: 'get'
  });
}
