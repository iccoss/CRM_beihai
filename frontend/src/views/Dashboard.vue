<template>
  <div class="dashboard">
    <div class="dashboard-period-bar">
      <div>
        <div class="dashboard-period-title">经营数据概览</div>
        <div class="dashboard-period-label">{{ dashboardPeriodLabel }}</div>
      </div>
      <div class="dashboard-period-controls">
        <el-segmented v-model="dashboardPeriod.type" :options="dashboardPeriodOptions" size="small" />
        <div class="period-switcher">
          <el-button aria-label="上一个周期" @click="changeDashboardPeriod(-1)">
            <el-icon><ArrowLeft /></el-icon>
          </el-button>
          <el-button aria-label="下一个周期" @click="changeDashboardPeriod(1)">
            <el-icon><ArrowRight /></el-icon>
          </el-button>
          <el-button :disabled="isCurrentDashboardPeriod" @click="goToCurrentDashboardPeriod">本期</el-button>
        </div>
      </div>
    </div>

    <div v-loading="periodDataLoading" class="stats-grid">
      <el-card v-for="metric in topMetrics" :key="metric.key" shadow="never" class="stat-card">
        <div class="stat-card-head">
          <span class="stat-title">{{ metric.label }}</span>
          <span class="stat-icon" :class="metric.iconClass">
            <el-icon :size="20"><component :is="metric.icon" /></el-icon>
          </span>
        </div>
        <div class="stat-value clickable-value" @click="goDetail(metric.link)">{{ formatMetricValue(metric) }}</div>
        <div v-if="metric.comparisonType === 'rate'" class="stat-comparison rate-comparison">
          <!-- 按年视图下季度完成率为空，仅在按季周期显示 -->
          <span v-if="dashboardPeriod.type === 'quarter'">季度完成率 <strong :class="getRateClass(metric.quarter_rate)">{{ formatRate(metric.quarter_rate) }}</strong></span>
          <span>年度完成率 <strong :class="getRateClass(metric.year_rate)">{{ formatRate(metric.year_rate) }}</strong></span>
        </div>
        <div v-else class="stat-comparison">
          <span>{{ metric.comparisonLabel }}</span>
          <strong :class="getDeltaClass(metric.delta)">{{ formatMetricDelta(metric) }}</strong>
        </div>
      </el-card>
    </div>

    <!-- 商机阶段月度趋势：固定当前年份，不受顶部周期切换器影响 -->
    <el-card shadow="never" class="chart-card stage-monthly-card">
      <template #header>
        <div class="card-header stage-monthly-header">
          <div>
            <span class="card-title">商机阶段月度趋势</span>
            <span class="card-subtitle">技术交流/POC/立项/招投标取自商机管理（按商机创建时间归月），已签合同取自合同管理（按合同签订日期归月）</span>
          </div>
          <div class="stage-year-switcher">
            <el-button aria-label="上一年" @click="changeStageMonthlyYear(-1)">
              <el-icon><ArrowLeft /></el-icon>
            </el-button>
            <span class="stage-year-label">{{ stageMonthlyYear }} 年</span>
            <el-button aria-label="下一年" @click="changeStageMonthlyYear(1)">
              <el-icon><ArrowRight /></el-icon>
            </el-button>
            <el-button :disabled="isCurrentStageMonthlyYear" @click="goToCurrentStageMonthlyYear">本年</el-button>
          </div>
        </div>
      </template>
      <div ref="stageMonthlyChart" class="chart stage-monthly-chart" v-loading="stageMonthlyLoading"></div>
    </el-card>

    <el-card shadow="never" class="opportunity-overview">
      <template #header>
        <div class="card-header opportunity-header">
          <div>
            <div>商机与销售运营</div>
            <div class="opportunity-period-note">在跟按预计签约时间，转化按合同签订时间</div>
          </div>
          <span class="section-period-label">{{ dashboardPeriodLabel }}</span>
        </div>
      </template>
      <div class="opportunity-metrics">
        <div class="metric-item"><span>在跟商机数量</span><strong class="clickable-value" @click="goDetail(activeOpportunityLink)">{{ opportunityPeriodMetrics.active_count }} 个</strong></div>
        <div v-if="!isTechnicalRole" class="metric-item"><span>在跟商机金额</span><strong class="clickable-value" @click="goDetail(activeOpportunityLink)">¥{{ formatLargeNumber(opportunityPeriodMetrics.active_amount) }}</strong></div>
        <div class="metric-item converted"><span>已转化商机数量</span><strong class="clickable-value" @click="goDetail(convertedLink)">{{ opportunityPeriodMetrics.converted_count }} 个</strong></div>
        <div v-if="!isTechnicalRole" class="metric-item converted"><span>已转化金额</span><strong class="clickable-value" @click="goDetail(convertedLink)">¥{{ formatLargeNumber(opportunityPeriodMetrics.converted_amount) }}</strong></div>
      </div>
    </el-card>

    <!-- 阶段进展统计：实时快照，不受周期切换器影响 -->
    <el-card shadow="never" class="stage-overview">
      <template #header>
        <div class="card-header">
          <div>
            <div>阶段进展</div>
            <div class="opportunity-period-note">当前处于各阶段的实时数量</div>
          </div>
        </div>
      </template>
      <div class="opportunity-metrics">
        <div class="metric-item stage-item poc"><span>POC中</span><strong class="clickable-value" @click="goDetail('/opportunities?status=poc')">{{ stageStats.poc_count }} 个</strong></div>
        <div class="metric-item stage-item project"><span>立项中</span><strong class="clickable-value" @click="goDetail('/opportunities?status=project')">{{ stageStats.project_count }} 个</strong></div>
        <div class="metric-item stage-item contracting"><span>合同中</span><strong class="clickable-value" @click="goDetail('/opportunities?status=contracting')">{{ stageStats.contracting_count }} 个</strong></div>
        <div class="metric-item stage-item payment"><span>回款中</span><strong class="clickable-value" @click="goDetail('/payments?status=pending')">{{ stageStats.payment_pending_count }} 个</strong></div>
      </div>
    </el-card>

    <!-- 转化漏斗：线索→技术交流→POC→立项→招投标→已签合同，实时快照，不受周期切换影响 -->
    <el-card shadow="never" class="funnel-overview">
      <template #header>
        <div class="card-header">
          <div>
            <div>转化漏斗</div>
            <div class="opportunity-period-note">线索→技术交流→POC→立项→招投标→已签合同</div>
          </div>
        </div>
      </template>
      <div ref="conversionFunnelChart" class="funnel-chart"></div>
    </el-card>

    <el-row :gutter="20" class="charts-row row-main">
      <el-col :span="isTechnicalRole ? 24 : 6" class="col-left">
        <el-card shadow="hover" class="reminder-card">
          <template #header>
            <div class="card-header">
              <span>提醒统计</span>
            </div>
          </template>
          <el-table :data="reminderData" style="width: 100%" :show-header="false" class="reminder-table">
            <el-table-column label="类型" min-width="0">
              <template #default="{ row }">
                <div class="reminder-name">
                  <el-icon :size="18" :color="row.iconColor"><component :is="row.icon" /></el-icon>
                  <span>{{ row.name }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="数量" width="60" align="right">
              <template #default="{ row }">
                <span class="clickable-value" :style="row.value > 0 ? 'color: #f54a45; font-weight: bold; font-size: 16px;' : 'color: #34c724; font-weight: bold; font-size: 16px;'" @click="goDetail(row.link)">
                  {{ row.value }}
                </span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col v-if="!isTechnicalRole" :span="18" class="col-right">
        <el-card shadow="hover" class="side-card">
          <template #header>
            <div class="card-header">
              <span>我的渠道</span>
            </div>
          </template>
          <div v-if="channelStats" class="channel-stats">
            <div class="channel-stat-item">
              <span class="channel-stat-label">渠道客户数</span>
              <span class="channel-stat-value">{{ channelStats.customerCount }} 个</span>
            </div>
            <div class="channel-stat-item">
              <span class="channel-stat-label">合同金额</span>
              <span class="channel-stat-value">¥{{ formatLargeNumber(channelStats.contractAmount) }}</span>
            </div>
            <div class="channel-stat-item">
              <span class="channel-stat-label">渠道分成</span>
              <span class="channel-stat-value" style="color: #34c724">¥{{ formatLargeNumber(channelStats.channelCommission) }}</span>
            </div>
          </div>
          <el-empty v-else description="暂无渠道数据" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 客户商机状态模块：按要求暂时注释隐藏，需要时恢复即可
    <el-row :gutter="20" class="charts-row customer-opportunity-section">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <div>
                <div>客户商机状态</div>
                <div class="opportunity-period-note">截至当前的累计数据，按客户聚合</div>
              </div>
              <div class="customer-opportunity-total">
                {{ customerOpportunityTotals.customerCount }} 家客户 · {{ customerOpportunityTotals.opportunityCount }} 个商机
              </div>
            </div>
          </template>
          <el-table
            v-loading="customerOpportunityLoading"
            :data="customerOpportunityRows"
            style="width: 100%"
            empty-text="当前周期暂无商机数据"
          >
            <el-table-column prop="customer_name" label="客户名称" min-width="180" fixed="left" show-overflow-tooltip />
            <el-table-column prop="opportunity_count" label="商机数量" width="100" align="center">
              <template #default="{ row }">
                <strong class="table-primary-count">{{ row.opportunity_count }}</strong>
              </template>
            </el-table-column>
            <el-table-column prop="active_count" label="在跟商机数" width="110" align="center">
              <template #default="{ row }">
                <span class="active-count">{{ row.active_count }}</span>
              </template>
            </el-table-column>
            <el-table-column label="商机状态" align="center">
              <el-table-column prop="potential_count" label="潜在" width="72" align="center" />
              <el-table-column prop="technical_count" label="技术交流" width="88" align="center" />
              <el-table-column prop="poc_count" label="POC" width="68" align="center" />
              <el-table-column prop="project_count" label="立项" width="68" align="center" />
              <el-table-column prop="bidding_count" label="招投标" width="78" align="center" />
              <el-table-column prop="contracting_count" label="合同中" width="78" align="center" />
              <el-table-column prop="signed_count" label="已签" width="68" align="center" />
              <el-table-column prop="lost_count" label="已丢失" width="78" align="center" />
            </el-table-column>
            <el-table-column label="技术协作" align="center">
              <el-table-column prop="presales_count" label="售前数量" width="90" align="center" />
              <el-table-column prop="fde_count" label="FDE数量" width="90" align="center" />
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
    -->

    <el-row :gutter="20" class="charts-row">
      <el-col :span="8">
        <el-card shadow="hover" class="chart-card">
          <template #header>
            <div class="card-header">
              <span>客户区域分布</span>
            </div>
          </template>
          <div ref="customerRegionChart" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="chart-card">
          <template #header>
            <div class="card-header">
              <span>客户行业分布</span>
            </div>
          </template>
          <div ref="customerIndustryChart" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="chart-card">
          <template #header>
            <div class="card-header">
              <span>跟进方式统计</span>
            </div>
          </template>
          <div ref="followupTypeChart" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近跟进：展示 FDE 与售前填写的跟进记录 -->
    <el-row :gutter="20" class="recent-row">
      <el-col :span="24">
        <el-card shadow="never" class="recent-followup-card">
          <template #header>
            <div class="card-header recent-followup-header">
              <span class="recent-followup-title">最近跟进</span>
              <el-button link type="primary" @click="goDetail('/followups')">查看全部</el-button>
            </div>
          </template>
          <el-table
            :data="recentFollowups"
            style="width: 100%"
            :show-header="false"
            class="recent-followup-table"
            empty-text="暂无跟进记录"
          >
            <el-table-column prop="customer_name" label="客户名称" width="180">
              <template #default="{ row }">
                <div class="followup-content-cell">{{ row.customer_name }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="user_name" label="跟进人" width="100">
              <template #default="{ row }">
                <div class="followup-content-cell">{{ row.user_name || '-' }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="user_role" label="角色" width="90">
              <template #default="{ row }">
                <el-tag v-if="row.user_role" size="small" type="info">{{ formatRole(row.user_role) }}</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column prop="content" label="跟进内容">
              <template #default="{ row }">
                <div class="followup-content-cell">{{ row.content }}</div>
              </template>
            </el-table-column>
            <el-table-column label="跟进时间" width="120">
              <template #default="{ row }">
                <div class="recent-followup-time">{{ (row.created_at || '').slice(0, 10) }}</div>
                <div class="recent-followup-time">{{ (row.created_at || '').slice(11, 19) }}</div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as echarts from 'echarts'
import request from '@/utils/request'

const router = useRouter()

// 在跟商机状态集合（除已签/已丢失外的所有状态），用于跳转商机列表筛选
const ACTIVE_OPPORTUNITY_QUERY = 'potential,technical,poc,project,bidding,contracting'
const activeOpportunityLink = `/opportunities?status=${ACTIVE_OPPORTUNITY_QUERY}`

// 数值点击跳转到对应详细列表
const goDetail = (path) => {
  if (path) router.push(path)
}

const stats = ref({
  customerCount: 0,
  customerAmount: 0,
  opportunityByStatus: [],
  opportunityMetrics: { active_count: 0, active_amount: 0, conversion_rate: 0 },
  followupCount: 0,
  renewAmount: 0,
  renewTarget: 0,
  renewRate: 0,
  newAmount: 0,
  newTarget: 0,
  newRate: 0,
  paymentAmount: 0,
  paymentTarget: 0,
  paymentRate: 0,
  contractExpiringCount: 0,
  paymentReminderCount: 0,
  customerReleaseCount: 0,
  birthdayReminderCount: 0
})
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const isTechnicalRole = ['presales', 'fde', 'fde_admin'].includes(currentUser.role)

// 最近跟进列表（FDE 与售前填写的跟进记录）
const recentFollowups = ref([])
const channelStats = ref(null)

const customerRegionChart = ref(null)
const customerIndustryChart = ref(null)
const followupTypeChart = ref(null)
// 转化漏斗图表容器
const conversionFunnelChart = ref(null)
// 商机阶段月度趋势：图表容器、所选年份（固定当前年份，可切换历史年份）、加载状态
const stageMonthlyChart = ref(null)
const stageMonthlyYear = ref(new Date().getFullYear())
const stageMonthlyLoading = ref(false)
// 是否当前年份：用于禁用"本年"按钮
const isCurrentStageMonthlyYear = computed(() => stageMonthlyYear.value === new Date().getFullYear())
const dashboardNow = new Date()
const opportunityPeriodMetrics = ref({
  active_count: 0,
  active_amount: 0,
  converted_count: 0,
  converted_amount: 0
})
// 阶段进展统计（实时快照）
const stageStats = ref({
  poc_count: 0,
  project_count: 0,
  contracting_count: 0,
  payment_pending_count: 0
})
const periodDataLoading = ref(false)
const customerOpportunityLoading = ref(false)
const customerOpportunityRows = ref([])
const periodSummary = ref({
  customer_total: { value: 0, previous_value: 0, delta: 0 },
  active_opportunity_count: { value: 0, previous_value: 0, delta: 0 },
  renewal_contract_amount: { value: 0, previous_value: 0, delta: 0, quarter_rate: null, year_rate: null },
  new_contract_amount: { value: 0, previous_value: 0, delta: 0, quarter_rate: null, year_rate: null },
  payment_amount: { value: 0, previous_value: 0, delta: 0, quarter_rate: null, year_rate: null }
})
// 首页周期默认按年统计
const dashboardPeriod = reactive({
  type: 'year',
  year: dashboardNow.getFullYear(),
  month: dashboardNow.getMonth() + 1,
  quarter: Math.floor(dashboardNow.getMonth() / 3) + 1
})
const dashboardPeriodOptions = [
  { label: '按季度', value: 'quarter' },
  { label: '按年', value: 'year' }
]
const dashboardPeriodLabel = computed(() => {
  if (dashboardPeriod.type === 'quarter') return `${dashboardPeriod.year} 年第 ${dashboardPeriod.quarter} 季度`
  return `${dashboardPeriod.year} 年`
})
const isCurrentDashboardPeriod = computed(() => {
  if (dashboardPeriod.type === 'quarter') {
    return dashboardPeriod.year === dashboardNow.getFullYear()
      && dashboardPeriod.quarter === Math.floor(dashboardNow.getMonth() / 3) + 1
  }
  return dashboardPeriod.year === dashboardNow.getFullYear()
})

const comparisonPeriodLabel = computed(() => {
  if (dashboardPeriod.type === 'quarter') return '较上季度'
  return '较上年'
})

// 计算当前所选周期对应的合同签订日期范围（后端按 sign_date <= end_date 过滤，故结束日期取周期最后一天）
const getPeriodDateRange = () => {
  const year = dashboardPeriod.year
  let startMonth
  let monthCount
  if (dashboardPeriod.type === 'quarter') {
    startMonth = (dashboardPeriod.quarter - 1) * 3 + 1
    monthCount = 3
  } else {
    startMonth = 1
    monthCount = 12
  }
  const formatDate = date => date.toISOString().slice(0, 10)
  return {
    startDate: formatDate(new Date(Date.UTC(year, startMonth - 1, 1))),
    endDate: formatDate(new Date(Date.UTC(year, startMonth - 1 + monthCount, 0)))
  }
}

// 已转化商机跳转链接：带所选周期的合同签订日期范围
const convertedLink = computed(() => {
  const { startDate, endDate } = getPeriodDateRange()
  return `/contracts?start_date=${startDate}&end_date=${endDate}`
})

const topMetrics = computed(() => {
  // 续签/新签/回款金额卡跳转时携带当前周期日期范围，保证列表与卡片统计区间一致
  const { startDate, endDate } = getPeriodDateRange()
  const metrics = [
    {
      key: 'customer_total', label: '客户总数', type: 'count', icon: 'User', iconClass: 'customer',
      comparisonLabel: '新增客户', link: '/customers', ...periodSummary.value.customer_total
    },
    {
      key: 'active_opportunity_count', label: '在跟商机总数', type: 'count', icon: 'TrendCharts', iconClass: 'opportunity',
      comparisonLabel: comparisonPeriodLabel.value, link: activeOpportunityLink, ...periodSummary.value.active_opportunity_count
    },
    {
      key: 'renewal_contract_amount', label: '续签合同金额', type: 'amount', icon: 'RefreshRight', iconClass: 'renew',
      comparisonType: 'rate', link: `/contracts?opportunity_type=renewal&start_date=${startDate}&end_date=${endDate}`, ...periodSummary.value.renewal_contract_amount
    },
    {
      key: 'new_contract_amount', label: '新签合同金额', type: 'amount', icon: 'Document', iconClass: 'new',
      comparisonType: 'rate', link: `/contracts?opportunity_type=new_project&start_date=${startDate}&end_date=${endDate}`, ...periodSummary.value.new_contract_amount
    },
    {
      key: 'payment_amount', label: '回款金额', type: 'amount', icon: 'Money', iconClass: 'payment',
      comparisonType: 'rate', link: `/payments?status=received&start_date=${startDate}&end_date=${endDate}`, ...periodSummary.value.payment_amount
    }
  ]
  return isTechnicalRole ? metrics.filter(metric => metric.type !== 'amount') : metrics
})

const customerOpportunityTotals = computed(() => customerOpportunityRows.value.reduce((total, row) => {
  total.customerCount += 1
  total.opportunityCount += Number(row.opportunity_count || 0)
  return total
}, { customerCount: 0, opportunityCount: 0 }))

const getDashboardPeriodParams = () => ({
  period_type: dashboardPeriod.type,
  year: dashboardPeriod.year,
  month: dashboardPeriod.month,
  quarter: dashboardPeriod.quarter
})

const formatNumber = (num) => {
  return (num || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

// 格式化大数字，对于超过千万的数字显示为带单位的形式
const formatLargeNumber = (num) => {
  num = num || 0
  if (num >= 100000000) {
    // 如果金额达到或超过1亿，显示为X.XX亿
    return (num / 100000000).toFixed(2) + ' 亿'
  } else if (num >= 10000000) {
    // 如果金额达到或超过1千万，显示为X.XX千万
    return (num / 10000000).toFixed(2) + ' 千万'
  } else if (num >= 10000) {
    // 如果金额达到或超过1万，显示为X.XX万
    return (num / 10000).toFixed(2) + ' 万'
  } else {
    // 小于1万的数字，直接显示
    return num.toString()
  }
}

const formatMetricValue = (metric) => {
  if (metric.value === null || metric.value === undefined) return '-'
  if (metric.type === 'amount') return `¥${formatLargeNumber(metric.value)}`
  return `${formatNumber(metric.value)} 个`
}

const formatMetricDelta = (metric) => {
  if (metric.delta === null || metric.delta === undefined) return '-'
  const value = Number(metric.delta || 0)
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  if (metric.type === 'amount') return `${sign}¥${formatLargeNumber(Math.abs(value))}`
  return `${sign}${formatNumber(Math.abs(value))}`
}

const getDeltaClass = (delta) => {
  if (Number(delta) > 0) return 'is-positive'
  if (Number(delta) < 0) return 'is-negative'
  return 'is-neutral'
}

// 完成率展示：目标额为 0 时后端返回 null，此处显示 -
const formatRate = (rate) => (rate === null || rate === undefined ? '-' : `${rate}%`)

// 完成率达到 100% 及以上显示绿色，否则为常规色
const getRateClass = (rate) => {
  if (rate === null || rate === undefined) return 'is-neutral'
  return Number(rate) >= 100 ? 'is-positive' : 'is-neutral'
}

const loadStats = async () => {
  try {
    console.log('加载统计数据...')
    const { data } = await request.get('/api/stats/overview')
    console.log('统计数据:', data)
    console.log('合同到期提醒数量:', data.contractExpiringCount)
    stats.value = {
      customerCount: data.customerCount || 0,
      customerAmount: data.customerAmount || 0,
      opportunityByStatus: data.opportunityByStatus || [],
      opportunityMetrics: data.opportunityMetrics || { active_count: 0, active_amount: 0, conversion_rate: 0 },
      followupCount: data.followupCount || 0,
      renewAmount: data.renewAmount || 0,
      renewTarget: data.renewTarget || 0,
      renewRate: data.renewRate || 0,
      newAmount: data.newAmount || 0,
      newTarget: data.newTarget || 0,
      newRate: data.newRate || 0,
      paymentAmount: data.paymentAmount || 0,
      paymentTarget: data.paymentTarget || 0,
      paymentRate: data.paymentRate || 0,
      contractExpiringCount: data.contractExpiringCount || 0,
      paymentReminderCount: data.paymentReminderCount || 0,
      customerReleaseCount: data.customerReleaseCount || 0,
      birthdayReminderCount: data.birthdayReminderCount || 0,
      customerQuota: data.customerQuota || 30
    }
  } catch (error) {
    console.error('加载统计数据失败:', error)
    console.error('错误详情:', error.response?.data)
  }
}

const loadOpportunityPeriodMetrics = async () => {
  try {
    const { data } = await request.get('/api/stats/opportunity-period-metrics', {
      params: getDashboardPeriodParams()
    })
    opportunityPeriodMetrics.value = {
      active_count: data.active_count || 0,
      active_amount: data.active_amount || 0,
      converted_count: data.converted_count || 0,
      converted_amount: data.converted_amount || 0
    }
  } catch (error) {
    console.error('加载商机周期指标失败:', error)
  }
}

// 加载阶段进展统计（实时快照，与周期切换无关，仅挂载时加载一次）
const loadStageStats = async () => {
  try {
    const { data } = await request.get('/api/stats/pipeline-stage-stats')
    stageStats.value = {
      poc_count: data.poc_count || 0,
      project_count: data.project_count || 0,
      contracting_count: data.contracting_count || 0,
      payment_pending_count: data.payment_pending_count || 0
    }
  } catch (error) {
    console.error('加载阶段进展统计失败:', error)
  }
}

const loadDashboardPeriodData = async () => {
  periodDataLoading.value = true
  try {
    const params = getDashboardPeriodParams()
    const [summaryRes] = await Promise.all([
      request.get('/api/stats/dashboard-period-summary', { params }),
      loadOpportunityPeriodMetrics()
    ])
    periodSummary.value = summaryRes.data.metrics || periodSummary.value
  } catch (error) {
    console.error('加载数据概览周期数据失败:', error)
  } finally {
    periodDataLoading.value = false
  }
}

const loadCustomerOpportunityStatus = async () => {
  customerOpportunityLoading.value = true
  try {
    const { data } = await request.get('/api/stats/customer-opportunity-status')
    customerOpportunityRows.value = data.data || []
  } catch (error) {
    console.error('加载客户商机累计数据失败:', error)
  } finally {
    customerOpportunityLoading.value = false
  }
}

const changeDashboardPeriod = (offset) => {
  if (dashboardPeriod.type === 'quarter') {
    const quarterIndex = dashboardPeriod.year * 4 + dashboardPeriod.quarter - 1 + offset
    dashboardPeriod.year = Math.floor(quarterIndex / 4)
    dashboardPeriod.quarter = quarterIndex % 4 + 1
  } else {
    dashboardPeriod.year += offset
  }
  loadDashboardPeriodData()
}

const goToCurrentDashboardPeriod = () => {
  dashboardPeriod.year = dashboardNow.getFullYear()
  dashboardPeriod.month = dashboardNow.getMonth() + 1
  dashboardPeriod.quarter = Math.floor(dashboardNow.getMonth() / 3) + 1
  loadDashboardPeriodData()
}

watch(() => dashboardPeriod.type, goToCurrentDashboardPeriod)

// 提醒数据（右侧表格）
const reminderData = computed(() => {
  return [
    {
      name: '待跟进',
      value: stats.value.followupCount,
      icon: 'ChatDotRound',
      iconColor: '#f54a45',
      description: '没有任何跟进记录的商机数量',
      link: '/opportunities'
    },
    {
      name: '合同到期提醒',
      value: stats.value.contractExpiringCount,
      icon: 'Document',
      iconColor: '#f54a45',
      description: '30 天内到期的合同数量',
      link: '/contracts?show_expiring=1'
    },
    {
      name: '收款提醒',
      value: stats.value.paymentReminderCount,
      icon: 'Money',
      iconColor: '#3370ff',
      description: '有未回款的合同数量',
      link: '/payments?status=pending'
    },
    {
      name: '客户释放提醒',
      value: stats.value.customerReleaseCount,
      icon: 'RefreshLeft',
      iconColor: '#00d6b9',
      description: '30 天无跟进的客户数量',
      link: '/customers'
    },
    {
      name: '生日提醒',
      value: stats.value.birthdayReminderCount || 0,
      icon: 'Present',
      iconColor: '#7f3bf5',
      description: '30 天内过生日的联系人数量',
      link: '/contacts?show_birthday=1'
    }
  ]
})

// 角色中文映射（与系统其他页面保持一致）
const ROLE_LABELS = {
  sales: '销售', presales: '售前', fde: 'FDE', fde_admin: 'FDE管理员',
  admin: '管理员', super_admin: '超管', operations: '运营', after_sales: '售后'
}
const formatRole = (role) => ROLE_LABELS[role] || role || '-'

// 加载最近跟进数据（仅展示 FDE 与售前填写的跟进）
const loadRecentData = async () => {
  try {
    const { data } = await request.get('/api/stats/recent-followups', { params: { limit: 5 } })
    recentFollowups.value = data.data || []
  } catch (error) {
    console.error('加载最近数据失败:', error)
  }
}

const loadChannelStats = async () => {
  if (isTechnicalRole) return
  try {
    const { data } = await request.get('/api/channels/my-stats')
    channelStats.value = data
  } catch (error) {
    console.error('加载渠道统计失败:', error)
  }
}

const createCustomerDistributionOption = (seriesName, chartData) => {
  const valueMap = Object.fromEntries(chartData.map(item => [item.name, item.value]))
  const total = chartData.reduce((sum, item) => sum + Number(item.value || 0), 0)

  return {
    tooltip: {
      trigger: 'item',
      formatter: params => `${params.name}<br/>${params.value} 个（${params.percent}%）`
    },
    title: {
      text: String(total),
      subtext: '客户总数',
      left: '30%',
      top: '41%',
      textAlign: 'center',
      textStyle: { color: '#1f2329', fontSize: 24, fontWeight: 700 },
      subtextStyle: { color: '#8f959e', fontSize: 11, lineHeight: 18 }
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      top: 'middle',
      right: '3%',
      width: '38%',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 12,
      icon: 'circle',
      selectedMode: false,
      textStyle: {
        color: '#646a73',
        fontSize: 12,
        width: 125,
        overflow: 'truncate',
        ellipsis: '…'
      },
      formatter: name => `${name}  ${valueMap[name] || 0}个`,
      tooltip: { show: true }
    },
    series: [{
      name: seriesName,
      type: 'pie',
      center: ['30%', '54%'],
      radius: ['40%', '66%'],
      avoidLabelOverlap: true,
      data: chartData,
      label: { show: false },
      labelLine: { show: false },
      emphasis: {
        scaleSize: 4,
        label: { show: false }
      }
    }]
  }
}

// 构建转化漏斗图表配置（标题 / 悬停提示 / 图例 / 漏斗系列）
// stages: [{ key, label, count }]，由后端 /api/stats/conversion-funnel 返回
const buildFunnelOption = (stages) => {
  const first = stages[0]
  // 总转化率：相对第一阶段（线索）的比例
  const totalRate = (count) => (first && first.count > 0 ? ((count / first.count) * 100).toFixed(1) + '%' : '-')
  return {
    // 图表标题
    title: {
      text: '客户转化漏斗',
      subtext: '单位：家客户',
      left: 'center',
      textStyle: { fontSize: 14, fontWeight: 600 }
    },
    // 悬停提示：展示该阶段客户数、较上一层转化率、总转化率、平均转化时间
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const idx = stages.findIndex(s => s.label === params.name)
        const cur = stages[idx]
        if (!cur) return params.name
        const prev = idx > 0 ? stages[idx - 1] : null
        const prevRate = prev && prev.count > 0 ? ((cur.count / prev.count) * 100).toFixed(1) + '%' : '-'
        // 平均转化时间：线索为起点阶段不展示；其余阶段取后端返回的 avg_days
        const avgDaysLine = idx === 0
          ? '平均转化时间：—（起点阶段）'
          : `平均转化时间：${cur.avg_days != null ? cur.avg_days + ' 天' : '—'}`
        return [
          `<strong>${cur.label}</strong>`,
          `客户数：${cur.count}`,
          `较上一层转化：${prevRate}`,
          `总转化率：${totalRate(cur.count)}`,
          avgDaysLine
        ].join('<br/>')
      }
    },
    // 图例：点击图例项可隐藏/显示对应阶段，实现数据筛选
    legend: {
      bottom: 0,
      left: 'center',
      data: stages.map(s => s.label)
    },
    series: [
      {
        name: '转化漏斗',
        type: 'funnel',
        left: '10%',
        right: '10%',
        top: 60, // 顶部给标题留空间
        bottom: 36, // 底部给图例留空间
        minSize: '24%', // 最小层宽度，避免底层过窄看不清
        maxSize: '100%',
        sort: 'none', // 保持阶段顺序展示（数量本身逐层递减）
        gap: 4, // 层与层之间的间距
        // 数据标签：层内显示「阶段：客户数」
        label: { show: true, position: 'inside', formatter: '{b}：{c}' },
        // 系列级边框：白色层也有边界，保持漏斗轮廓清晰
        itemStyle: { borderColor: '#dcdfe6', borderWidth: 1 },
        data: stages.map(s => ({
          name: s.label,
          value: s.count,
          // 数量为 0 的层用白色展示，文字用灰色保证可读
          itemStyle: s.count === 0 ? { color: '#ffffff' } : undefined,
          label: { color: s.count === 0 ? '#909399' : '#ffffff' }
        }))
      }
    ]
  }
}

// 加载转化漏斗数据：后端按当前用户可见范围返回各阶段客户数
const loadConversionFunnel = async () => {
  if (!conversionFunnelChart.value) return
  try {
    const { data } = await request.get('/api/stats/conversion-funnel')
    const stages = data?.data?.stages || []
    const chart = echarts.init(conversionFunnelChart.value)
    chart.setOption(buildFunnelOption(stages))
  } catch (error) {
    console.error('加载转化漏斗数据失败:', error)
  }
}

// 初始化客户区域分布、客户行业分布、跟进方式统计三个图表
const initCharts = async () => {
  // 客户区域分布
  if (customerRegionChart.value) {
    try {
      const { data } = await request.get('/api/stats/customers?group_by=region')
      const chart = echarts.getInstanceByDom(customerRegionChart.value) || echarts.init(customerRegionChart.value)
      const regionData = (data.stats || []).map(item => ({ value: item.count, name: item.region || '未知区域' }))
      chart.setOption(createCustomerDistributionOption('客户区域', regionData))
    } catch (error) {
      console.error('加载客户区域数据失败:', error)
    }
  }
  // 客户行业分布
  if (customerIndustryChart.value) {
    try {
      const { data } = await request.get('/api/stats/customers?group_by=industry')
      const industryData = (data.stats || []).map(item => ({ value: item.count, name: item.industry || '未分类' }))
      const chart = echarts.getInstanceByDom(customerIndustryChart.value) || echarts.init(customerIndustryChart.value)
      chart.setOption(createCustomerDistributionOption('客户行业', industryData))
    } catch (error) {
      console.error('加载客户行业数据失败:', error)
    }
  }
  // 跟进方式统计
  if (followupTypeChart.value) {
    try {
      const response = await request.get('/api/stats/followup-type-stats')
      const typeMap = { phone: '电话', wechat: '微信', visit: '拜访', email: '邮件', other: '其他' }
      const typeData = (response.data?.data || []).map(item => ({ name: typeMap[item.type] || item.type, count: item.count }))
      const chart = echarts.getInstanceByDom(followupTypeChart.value) || echarts.init(followupTypeChart.value)
      chart.setOption({
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: typeData.map(item => item.name) },
        yAxis: { type: 'value' },
        series: [{ data: typeData.map(item => item.count), type: 'bar', itemStyle: { color: '#3370ff' } }]
      })
    } catch (error) {
      console.error('加载跟进方式数据失败:', error)
    }
  }
}

// 计算商机阶段月度趋势的可展示月份数：
// 当前年份只展示到当前月（未来月份即使有预填数据也不展示），其他年份展示完整 12 个月
const getStageMonthlyVisibleCount = () => {
  const now = new Date()
  if (stageMonthlyYear.value === now.getFullYear()) return now.getMonth() + 1
  return 12
}

// 构建商机阶段月度趋势折线图配置
const buildStageMonthlyOption = (stages) => {
  const visibleCount = getStageMonthlyVisibleCount()
  return {
    tooltip: {
      trigger: 'axis',
      // hover 提示：标题为月份，逐行显示各阶段的具体商机数（未展示的未来月份不参与提示）
      formatter: (params) => {
        const lines = (params || [])
          .filter(item => item.value !== null && item.value !== undefined)
          .map(item => `${item.marker}${item.seriesName}：${item.value} 个`)
        return `${params?.[0]?.axisValue ?? ''}<br/>${lines.join('<br/>') || '暂无数据'}`
      }
    },
    legend: { bottom: 0, left: 'center', data: stages.map(s => s.label) },
    grid: { left: '3%', right: '4%', top: 30, bottom: 40, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: Array.from({ length: 12 }, (_, i) => `${i + 1}月`)
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: stages.map(s => ({
      name: s.label,
      type: 'line',
      symbolSize: 6,
      // 超出可展示范围的月份置为 null，折线在当前月自然结束，不再延伸到未来月份
      data: (s.monthly || []).slice(0, 12).map((value, index) => (index < visibleCount ? (value ?? 0) : null))
    }))
  }
}

// 加载商机阶段月度趋势：按所选年份请求后端统计
const loadStageMonthlyStats = async () => {
  if (!stageMonthlyChart.value) return
  stageMonthlyLoading.value = true
  try {
    const { data } = await request.get('/api/stats/opportunity-stage-monthly', {
      params: { year: stageMonthlyYear.value }
    })
    const stages = data?.data?.stages || []
    const chart = echarts.getInstanceByDom(stageMonthlyChart.value) || echarts.init(stageMonthlyChart.value)
    chart.setOption(buildStageMonthlyOption(stages), true)
  } catch (error) {
    console.error('加载商机阶段月度趋势失败:', error)
  } finally {
    stageMonthlyLoading.value = false
  }
}

// 切换商机阶段月度趋势的统计年份
const changeStageMonthlyYear = (offset) => {
  stageMonthlyYear.value += offset
  loadStageMonthlyStats()
}

// 回到当前年份
const goToCurrentStageMonthlyYear = () => {
  stageMonthlyYear.value = new Date().getFullYear()
  loadStageMonthlyStats()
}

onMounted(() => {
  loadStats()
  loadDashboardPeriodData()
  loadStageStats()
  // loadCustomerOpportunityStatus() // 客户商机状态卡片已注释隐藏
  loadRecentData()
  loadChannelStats()
  // 转化漏斗：实时快照，与周期无关
  loadConversionFunnel()
  // 商机阶段月度趋势：固定当前年份，与顶部周期切换器无关
  loadStageMonthlyStats()
  // 区域/行业/跟进方式三个图表
  setTimeout(initCharts, 100)
  window.addEventListener('resize', () => {
    customerRegionChart.value && echarts.getInstanceByDom(customerRegionChart.value)?.resize()
    customerIndustryChart.value && echarts.getInstanceByDom(customerIndustryChart.value)?.resize()
    followupTypeChart.value && echarts.getInstanceByDom(followupTypeChart.value)?.resize()
    conversionFunnelChart.value && echarts.getInstanceByDom(conversionFunnelChart.value)?.resize()
    stageMonthlyChart.value && echarts.getInstanceByDom(stageMonthlyChart.value)?.resize()
  })
})
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.dashboard-period-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-lg);
  margin-bottom: var(--spacing-md);
}

.dashboard-period-title {
  color: var(--color-text-primary);
  font-size: 18px;
  font-weight: 700;
}

.dashboard-period-label {
  margin-top: 3px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.dashboard-period-controls,
.period-switcher {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-xl);
  padding-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--color-border-light);
}

.stat-card {
  height: 126px;
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
}

.stat-card:hover {
  border-color: var(--color-border);
  box-shadow: var(--shadow-sm);
}

.stat-card :deep(.el-card__body) {
  display: flex;
  height: 100%;
  flex-direction: column;
  padding: 16px 18px;
}

.stat-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}

.stat-icon {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
}

.stat-icon.customer {
  color: #3370ff;
  background: #e1e9ff;
}

.stat-icon.opportunity {
  color: #04b49c;
  background: #e0f7f2;
}

.stat-icon.renew {
  color: #ff8800;
  background: #fff3e0;
}

.stat-icon.new {
  color: #7f3bf5;
  background: #f1ebff;
}

.stat-icon.payment {
  color: #2aa61e;
  background: #e8f7e5;
}

.stat-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.stat-value {
  margin-top: 8px;
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text-primary);
  white-space: nowrap;
  letter-spacing: 0;
}

.stat-comparison {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.stat-comparison strong {
  font-weight: 700;
}

/* 完成率比较行：季度与年度完成率分列两端 */
.stat-comparison.rate-comparison {
  justify-content: space-between;
}

.stat-comparison .is-positive { color: #2aa61e; }
.stat-comparison .is-negative { color: #f54a45; }
.stat-comparison .is-neutral { color: var(--color-text-secondary); }

.charts-row, .recent-row {
  margin-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--color-border-light);
  padding-bottom: var(--spacing-xl);
}

.channel-stats {
  padding: var(--spacing-sm) var(--spacing-md);
}

.channel-stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-sm) 0;
  border-bottom: 1px solid var(--color-border-extra-light);
}

.channel-stat-item:last-child {
  border-bottom: none;
}

.channel-stat-label {
  font-size: 13px;
  color: var(--color-text-regular);
  font-weight: 500;
}

.channel-stat-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.reminder-table .el-table__row td {
  padding: 6px 0;
}

.reminder-table .el-table__cell {
  border: none;
  background: transparent;
}

.reminder-name {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.charts-row .el-card__body {
  padding: var(--spacing-lg);
}

.row-main {
  display: flex;
}

.row-main .col-left,
.row-main .col-right {
  display: flex;
  flex-direction: column;
}

.row-main .col-left .el-card {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.row-main .col-left .el-card .el-card__body {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.side-card {
  height: 100%;
  min-height: auto;
}

.side-card .el-card__body {
  padding: var(--spacing-sm) var(--spacing-lg);
}

.chart-card {
  min-height: 320px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.followup-content-cell {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  max-height: 80px;
  overflow-y: auto;
  padding: var(--spacing-xs) 0;
}

.chart {
  height: 300px;
}

.funnel-chart {
  height: 400px;
}

/* 商机阶段月度趋势卡片 */
.stage-monthly-card {
  margin-bottom: var(--spacing-lg);
}

.stage-monthly-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

/* 卡片副标题说明文字 */
.stage-monthly-header .card-subtitle {
  display: block;
  margin-top: 3px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.stage-year-switcher {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.stage-year-label {
  min-width: 64px;
  text-align: center;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 600;
}

.stage-monthly-chart {
  height: 360px;
}

.opportunity-overview {
  margin-bottom: var(--spacing-lg);
}

.opportunity-header {
  gap: var(--spacing-lg);
}

.opportunity-period-note {
  margin-top: 3px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.section-period-label,
.customer-opportunity-total {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.opportunity-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--spacing-lg);
}

.metric-item {
  border-left: 3px solid var(--color-primary);
  padding: var(--spacing-xs) var(--spacing-md);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.metric-item span { color: var(--color-text-secondary); font-size: 13px; }
.metric-item strong { font-size: 20px; color: var(--color-text-primary); }
.metric-item.converted { border-left-color: var(--color-success); }

/* 阶段进展卡片 */
.stage-overview {
  margin-bottom: var(--spacing-lg);
}

.stage-item.poc { border-left-color: #e6a23c; }
.stage-item.project { border-left-color: var(--color-primary); }
.stage-item.contracting { border-left-color: var(--color-success); }
.stage-item.payment { border-left-color: #409eff; }

/* 可点击数值：跳转到对应详细列表 */
.clickable-value { cursor: pointer; transition: color 0.2s ease, opacity 0.2s ease; }
.clickable-value:hover { color: var(--color-primary); }
.reminder-table .clickable-value:hover { opacity: 0.75; }

.table-primary-count {
  color: var(--color-text-primary);
  font-size: 14px;
}

.active-count {
  display: inline-flex;
  min-width: 28px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: #3370ff;
  background: #e1e9ff;
  font-weight: 700;
}

.customer-opportunity-section :deep(.el-table__header-wrapper thead:first-child th) {
  background: #f8f9fa;
}

.customer-opportunity-section :deep(.el-table__cell) {
  padding: 8px 0;
}

@media (max-width: 1400px) {
  .stats-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 900px) {
  .dashboard-period-bar { align-items: flex-start; flex-direction: column; }
  .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .opportunity-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .opportunity-header { align-items: flex-start; flex-direction: column; }
}

@media (max-width: 560px) {
  .dashboard-period-controls {
    align-items: flex-start;
    flex-direction: column;
  }
  .period-switcher {
    flex-wrap: wrap;
  }
  .stats-grid { grid-template-columns: 1fr; }
}

/* 最近跟进卡片：浅灰底、圆角，头部标题 + 查看全部链接 */
.recent-followup-card {
  border: none;
  border-radius: 8px;
  background: #f7f8fa;
}

.recent-followup-card :deep(.el-card__header) {
  padding: 14px 20px;
  border-bottom: 1px solid #e8eaed;
}

.recent-followup-card :deep(.el-card__body) {
  padding: 0 20px;
}

.recent-followup-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-primary);
}

/* 表格透明背景，仅保留行分隔线 */
.recent-followup-table {
  --el-table-border-color: #e8eaed;
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-row-hover-bg-color: rgba(255, 255, 255, 0.65);
  --el-table-text-color: var(--color-text-primary);
}

.recent-followup-table :deep(.el-table__cell) {
  padding: 12px 0;
}

/* 跟进时间分两行展示（日期 / 时分秒） */
.recent-followup-time {
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-primary);
}
</style>
