<template>
  <div class="statistics">
    <div class="statistics-toolbar">
      <div class="statistics-title">数据统计</div>
      <el-button :loading="exporting" :disabled="activeTab === 'conversionTime'" @click="exportStatistics">
        <el-icon><Download /></el-icon>
        导出当前数据
      </el-button>
    </div>
    <el-tabs v-model="activeTab" type="card" @tab-click="handleTabClick">
      <el-tab-pane label="📊 综合看板" name="dashboard" />
      <el-tab-pane label="📅 时间趋势" name="timeTrend" />
      <el-tab-pane label="🎯 商机分析" name="opportunity" />
      <el-tab-pane v-if="!isFdeAdmin" label="📄 合同分析" name="contract" />
      <el-tab-pane v-if="!isFdeAdmin" label="💰 回款分析" name="payment" />
      <el-tab-pane label="📦 产品分析" name="product" />
      <el-tab-pane v-if="canAccessConversion" label="⏱ 商机转化周期分析" name="conversionTime" />
      <el-tab-pane label="👥 人力资源投入" name="workforce" />
    </el-tabs>

    <!-- ==================== 综合看板 ==================== -->
    <div v-show="activeTab === 'dashboard'" v-loading="dashboardLoading">
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="6">
          <el-card shadow="hover" class="metric-card">
            <div class="metric-value" style="color: #3370ff;">{{ coreMetrics.customer_count || 0 }}</div>
            <div class="metric-label">客户总数</div>
            <div class="metric-sub" v-if="!isFdeAdmin">总金额 ¥{{ fmt(coreMetrics.customer_amount) }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover" class="metric-card">
            <div class="metric-value" style="color: #ff8800;">{{ coreMetrics.opp_count || 0 }}</div>
            <div class="metric-label">商机总数</div>
            <div class="metric-sub" v-if="!isFdeAdmin">已签 ¥{{ fmt(coreMetrics.signed_opp_amount) }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover" class="metric-card">
            <div class="metric-value" style="color: #34c724;">{{ coreMetrics.contract_count || 0 }}</div>
            <div class="metric-label">合同总数</div>
            <div class="metric-sub" v-if="!isFdeAdmin">总金额 ¥{{ fmt(coreMetrics.contract_amount) }}</div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card shadow="hover" class="metric-card">
            <div class="metric-value" style="color: #f54a45;">{{ coreMetrics.payment_count || 0 }}</div>
            <div class="metric-label">回款笔数</div>
            <div class="metric-sub" v-if="!isFdeAdmin">总金额 ¥{{ fmt(coreMetrics.payment_amount) }}</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 年度对比 -->
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="24">
          <el-card>
            <template #header><span style="font-weight: bold;">年度对比（{{ CY }} vs {{ LY }}）</span></template>
            <el-table :data="yearCompareData" size="small">
              <el-table-column prop="name" label="指标" width="120" />
              <el-table-column :label="CY + '年'" align="right">
                <template #default="{ row }">{{ row.isAmt && isFdeAdmin ? '-' : (row.isAmt ? '¥' + fmt(row.ty) : row.ty) }}</template>
              </el-table-column>
              <el-table-column :label="LY + '年'" align="right">
                <template #default="{ row }">{{ row.isAmt && isFdeAdmin ? '-' : (row.isAmt ? '¥' + fmt(row.ly) : row.ly) }}</template>
              </el-table-column>
              <el-table-column label="同比" align="right" width="120">
                <template #default="{ row }">
                  <span v-if="row.ly > 0" :style="{ color: (row.ty - row.ly) >= 0 ? '#34c724' : '#f54a45', fontWeight: 'bold' }">
                    {{ ((row.ty - row.ly) / row.ly * 100).toFixed(1) }}%
                  </span>
                  <span v-else style="color: #8f959e;">—</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <!-- 月度回款趋势 -->
      <el-row :gutter="16" style="margin-bottom: 20px;" v-if="!isFdeAdmin">
        <el-col :span="24">
          <el-card>
            <template #header><span style="font-weight: bold;">月度回款趋势</span></template>
            <div ref="paymentTrendChart" style="height: 350px;"></div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 四宫格 -->
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="12">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">行业分布（{{ isFdeAdmin ? '合同数' : '合同金额' }}）</span>
                <el-radio-group v-model="industryYear" size="small" v-if="!isFdeAdmin">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="industryTableData" size="small" max-height="300">
              <el-table-column prop="industry" label="行业" />
              <el-table-column prop="contract_count" label="合同数" width="80" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="contract_amount" label="合同金额" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
              </el-table-column>
              <el-table-column v-if="!isFdeAdmin" prop="received_amount" label="已回款" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col :span="12">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">区域分布（{{ isFdeAdmin ? '合同数' : '合同金额' }}）</span>
                <el-radio-group v-model="regionYear" size="small" v-if="!isFdeAdmin">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="regionTableData" size="small" max-height="300">
              <el-table-column prop="region" label="区域" />
              <el-table-column prop="contract_count" label="合同数" width="80" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="contract_amount" label="合同金额" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
              </el-table-column>
              <el-table-column v-if="!isFdeAdmin" prop="received_amount" label="已回款" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="12">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">商机状态分布</span>
                <el-radio-group v-model="oppStatusYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="oppStatusTableData" size="small" max-height="300">
              <el-table-column prop="status" label="状态" width="120">
                <template #default="{ row }">{{ statusLabel(row.status) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="数量" width="80" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="amount" label="金额" align="right">
                <template #default="{ row }">¥{{ fmt(row.amount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col :span="12" v-if="!isFdeAdmin">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">合同类型分布</span>
                <el-radio-group v-model="contractTypeYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="contractTypeTableData" size="small" max-height="300">
              <el-table-column prop="type" label="类型" width="120">
                <template #default="{ row }">{{ oppTypeLabel(row.type) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="数量" width="80" align="center" />
              <el-table-column prop="total_amount" label="总金额" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.total_amount) }}</template>
              </el-table-column>
              <el-table-column prop="received_amount" label="已回款" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
              </el-table-column>
              <el-table-column prop="unpaid_amount" label="未回款" width="130" align="right">
                <template #default="{ row }" style="color:#f54a45">¥{{ fmt(row.unpaid_amount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <!-- 销售人员排名 -->
      <el-row :gutter="16" v-if="userRole === 'admin' && !isFdeAdmin" style="margin-bottom: 20px;">
        <el-col :span="24">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">销售人员排名（按回款金额）</span>
                <el-radio-group v-model="salesYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="salesTableData" size="small" stripe>
              <el-table-column type="index" label="排名" width="70" align="center">
                <template #default="{ $index }">
                  <el-tag :type="$index < 3 ? 'danger' : 'info'" size="small">{{ $index + 1 }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column prop="contract_count" label="合同数" width="80" align="center" />
              <el-table-column prop="contract_amount" label="合同金额" width="130" align="right">
                <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
              </el-table-column>
              <el-table-column prop="payment_amount" label="回款金额" width="140" align="right">
                <template #default="{ row }"><span style="color:#34c724;font-weight:bold">¥{{ fmt(row.payment_amount) }}</span></template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <!-- 产品分析 -->
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="24">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">产品分析（按意向产品统计）</span>
                <el-radio-group v-model="pdYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="pdTableData" size="small" max-height="300">
              <el-table-column type="index" label="#" width="50" align="center" />
              <el-table-column prop="product_name" label="产品名" min-width="140" />
              <el-table-column prop="opp_count" label="商机数" width="70" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="opp_amount" label="商机金额" width="120" align="right">
                <template #default="{ row }">¥{{ fmt(row.opp_amount) }}</template>
              </el-table-column>
              <el-table-column prop="signed_opp_count" label="已签商机" width="80" align="center" />

              <el-table-column prop="contract_count" label="合同数" width="70" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="contract_amount" label="合同金额" width="120" align="right">
                <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
              </el-table-column>
              <el-table-column v-if="!isFdeAdmin" prop="received_amount" label="已回款" width="120" align="right">
                <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
              </el-table-column>
              <el-table-column label="转化率" width="80" align="center">
                <template #default="{ row }">
                  <span v-if="row.opp_count > 0" :style="{ color: parseFloat(row.signed_opp_count / row.opp_count * 100) >= 30 ? '#34c724' : '#ff8800', fontWeight: 'bold' }">
                    {{ (row.signed_opp_count / row.opp_count * 100).toFixed(1) }}%
                  </span>
                  <span v-else style="color: #8f959e;">—</span>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- ==================== 时间趋势 ==================== -->
    <div v-show="activeTab === 'timeTrend'" v-loading="timeLoading">
      <el-card style="margin-bottom: 20px;" v-if="!isFdeAdmin">
        <template #header><span style="font-weight: bold;">{{ CY }} vs {{ LY }} 月度回款对比</span></template>
        <div ref="timeChart" style="height: 400px;"></div>
      </el-card>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-card>
            <template #header><span style="font-weight: bold;">{{ CY }} 年度汇总</span></template>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="回款笔数">{{ timeData.currentYearSummary?.payment_count || 0 }}</el-descriptions-item>
              <el-descriptions-item v-if="!isFdeAdmin" label="回款金额">¥{{ fmt(timeData.currentYearSummary?.payment_amount) }}</el-descriptions-item>
              <el-descriptions-item label="签约笔数">{{ timeData.currentYearSummary?.contract_count || 0 }}</el-descriptions-item>
              <el-descriptions-item v-if="!isFdeAdmin" label="签约金额">¥{{ fmt(timeData.currentYearSummary?.contract_amount) }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
        <el-col :span="12">
          <el-card>
            <template #header><span style="font-weight: bold;">{{ LY }} 年度汇总</span></template>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="回款笔数">{{ timeData.lastYearSummary?.payment_count || 0 }}</el-descriptions-item>
              <el-descriptions-item v-if="!isFdeAdmin" label="回款金额">¥{{ fmt(timeData.lastYearSummary?.payment_amount) }}</el-descriptions-item>
              <el-descriptions-item label="签约笔数">{{ timeData.lastYearSummary?.contract_count || 0 }}</el-descriptions-item>
              <el-descriptions-item v-if="!isFdeAdmin" label="签约金额">¥{{ fmt(timeData.lastYearSummary?.contract_amount) }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- ==================== 商机分析 ==================== -->
    <div v-show="activeTab === 'opportunity'" v-loading="oppLoading">
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="8">
          <el-card shadow="hover">
            <div class="metric-value" style="color:#3370ff">{{ oppData.total || 0 }}</div>
            <div class="metric-label">{{ CY }}年商机总数</div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="hover">
            <div class="metric-value" style="color:#34c724">{{ oppData.signed || 0 }}</div>
            <div class="metric-label">{{ CY }}年已签商机</div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="hover">
            <div class="metric-value" style="color:#ff8800">{{ oppData.conversionRate || 0 }}%</div>
            <div class="metric-label">{{ CY }}年转化率</div>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="16">
        <el-col :span="12">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">按状态分布</span>
                <el-radio-group v-model="oppStYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="oppStTableData" stripe>
              <el-table-column prop="status" label="状态" width="120">
                <template #default="{ row }">{{ statusLabel(row.status) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="数量" width="80" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="amount" label="金额" align="right">
                <template #default="{ row }">¥{{ fmt(row.amount) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
        <el-col :span="12">
          <el-card>
            <template #header>
              <div class="table-header">
                <span style="font-weight: bold;">按类型分布</span>
                <el-radio-group v-model="oppTyYear" size="small">
                  <el-radio-button :value="CY">{{ CY }}</el-radio-button>
                  <el-radio-button :value="LY">{{ LY }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <el-table :data="oppTyTableData" stripe>
              <el-table-column prop="type" label="类型" width="120">
                <template #default="{ row }">{{ oppTypeLabel(row.type) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="数量" width="80" align="center" />
              <el-table-column v-if="!isFdeAdmin" prop="amount" label="金额" width="140" align="right">
                <template #default="{ row }">¥{{ fmt(row.amount) }}</template>
              </el-table-column>
              <el-table-column prop="signed_count" label="已签" width="80" align="center" />
            </el-table>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- ==================== 合同分析 ==================== -->
    <div v-show="activeTab === 'contract'" v-loading="contractLoading">
      <el-card>
        <template #header>
          <div class="table-header">
            <span style="font-weight: bold;">合同类型分析</span>
            <el-radio-group v-model="ctYear" size="small">
              <el-radio-button :value="CY">{{ CY }}</el-radio-button>
              <el-radio-button :value="LY">{{ LY }}</el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <el-table :data="ctTableData" stripe>
          <el-table-column prop="type" label="类型" width="120">
            <template #default="{ row }">{{ oppTypeLabel(row.type) }}</template>
          </el-table-column>
          <el-table-column prop="count" label="数量" width="80" align="center" />
          <el-table-column prop="total_amount" label="总金额" width="140" align="right">
            <template #default="{ row }">¥{{ fmt(row.total_amount) }}</template>
          </el-table-column>
          <el-table-column prop="received_amount" label="已回款" width="140" align="right">
            <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
          </el-table-column>
          <el-table-column prop="unpaid_amount" label="未回款" width="140" align="right">
            <template #default="{ row }" style="color:#f54a45">¥{{ fmt(row.unpaid_amount) }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- ==================== 回款分析 ==================== -->
    <div v-show="activeTab === 'payment'" v-loading="paymentLoading">
      <el-row :gutter="16" style="margin-bottom: 20px;">
        <el-col :span="12">
          <el-card>
            <template #header><span style="font-weight: bold;">{{ CY }} 年回款汇总</span></template>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="回款笔数">{{ paymentData.currentYearSummary?.count || 0 }}</el-descriptions-item>
              <el-descriptions-item label="回款金额"><span style="color:#34c724;font-weight:bold;font-size:16px">¥{{ fmt(paymentData.currentYearSummary?.total_amount) }}</span></el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
        <el-col :span="12">
          <el-card>
            <template #header><span style="font-weight: bold;">{{ LY }} 年回款汇总</span></template>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="回款笔数">{{ paymentData.lastYearSummary?.count || 0 }}</el-descriptions-item>
              <el-descriptions-item label="回款金额"><span style="color:#34c724;font-weight:bold;font-size:16px">¥{{ fmt(paymentData.lastYearSummary?.total_amount) }}</span></el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
      </el-row>

      <el-card>
        <template #header>
          <div class="table-header">
            <span style="font-weight: bold;">按回款方式统计</span>
            <el-radio-group v-model="pmYear" size="small">
              <el-radio-button :value="CY">{{ CY }}</el-radio-button>
              <el-radio-button :value="LY">{{ LY }}</el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <el-table :data="pmTableData" stripe>
          <el-table-column type="index" label="#" width="60" align="center" />
          <el-table-column prop="method" label="回款方式" width="120">
            <template #default="{ row }">{{ methodLabel(row.method) }}</template>
          </el-table-column>
          <el-table-column prop="count" label="笔数" width="80" align="center" />
          <el-table-column prop="total_amount" label="总金额" align="right">
            <template #default="{ row }">¥{{ fmt(row.total_amount) }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- ==================== 产品分析 ==================== -->
    <div v-show="activeTab === 'product'" v-loading="productLoading">
      <el-card>
        <template #header>
          <div class="table-header">
            <span style="font-weight: bold;">产品分析（按意向产品统计）</span>
            <el-radio-group v-model="pdYear" size="small">
              <el-radio-button :value="CY">{{ CY }}</el-radio-button>
              <el-radio-button :value="LY">{{ LY }}</el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <el-table :data="pdTableData" stripe>
          <el-table-column type="index" label="#" width="60" align="center" />
          <el-table-column prop="product_name" label="产品名" min-width="140" />
          <el-table-column prop="opp_count" label="商机数" width="80" align="center" />
          <el-table-column v-if="!isFdeAdmin" prop="opp_amount" label="商机金额" width="130" align="right">
            <template #default="{ row }">¥{{ fmt(row.opp_amount) }}</template>
          </el-table-column>
          <el-table-column prop="signed_opp_count" label="已签商机" width="90" align="center" />
          <el-table-column prop="contract_count" label="合同数" width="80" align="center" />
          <el-table-column v-if="!isFdeAdmin" prop="contract_amount" label="合同金额" width="130" align="right">
            <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
          </el-table-column>
          <el-table-column v-if="!isFdeAdmin" prop="received_amount" label="已回款" width="130" align="right">
            <template #default="{ row }">¥{{ fmt(row.received_amount) }}</template>
          </el-table-column>
          <el-table-column label="转化率" width="90" align="center">
            <template #default="{ row }">
              <span v-if="row.opp_count > 0" :style="{ color: parseFloat(row.signed_opp_count / row.opp_count * 100) >= 30 ? '#34c724' : '#ff8800', fontWeight: 'bold' }">
                {{ (row.signed_opp_count / row.opp_count * 100).toFixed(1) }}%
              </span>
              <span v-else style="color: #8f959e;">—</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- ==================== 商机转化周期分析 ==================== -->
    <div v-show="activeTab === 'conversionTime'" v-loading="conversionLoading">

      <!-- 阶段停留时间柱状图 -->
      <el-card style="margin-bottom: 20px;">
        <template #header><span style="font-weight: bold;">📊 各阶段平均停留时间</span></template>
        <div ref="stageDurationChart" style="height: 350px;"></div>
      </el-card>

      <!-- 全程转化周期 — 按产品维度 -->
      <el-card style="margin-bottom: 20px;">
        <template #header><span style="font-weight: bold;">⏱ 全程转化周期（创建 → 已签）按产品</span></template>
        <el-table :data="convData.fullCycleByProduct || []" stripe>
          <el-table-column prop="product_name" label="产品" width="140" />
          <el-table-column prop="converted_count" label="已签数量" width="100" align="center" />
          <el-table-column prop="avg_total_days" label="平均天数(天)" width="110" align="right">
            <template #default="{ row }">{{ row.avg_total_days || '—' }}</template>
          </el-table-column>
          <el-table-column prop="min_total_days" label="最短(天)" width="90" align="right">
            <template #default="{ row }">{{ row.min_total_days || '—' }}</template>
          </el-table-column>
          <el-table-column prop="max_total_days" label="最长(天)" width="90" align="right">
            <template #default="{ row }">{{ row.max_total_days || '—' }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 销售转化排行 -->
      <el-card>
        <template #header><span style="font-weight: bold;">🏆 销售转化排行</span></template>
        <el-table :data="convData.salesConversionRate || []" stripe>
          <el-table-column type="index" label="排名" width="70" align="center">
            <template #default="{ $index }">
              <el-tag :type="$index < 3 ? 'danger' : 'info'" size="small">{{ $index + 1 }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="sales_name" label="销售" width="120" />
          <el-table-column prop="product_name" label="产品" width="140" />
          <el-table-column prop="total_opp" label="总商机" width="90" align="center" />
          <el-table-column prop="signed_count" label="已签" width="80" align="center" />
          <el-table-column prop="avg_days" label="平均转化天数(天)" width="130" align="right">
            <template #default="{ row }">{{ row.avg_days || '—' }}</template>
          </el-table-column>
          <el-table-column prop="min_days" label="最短(天)" width="90" align="right">
            <template #default="{ row }">{{ row.min_days || '—' }}</template>
          </el-table-column>
          <el-table-column prop="max_days" label="最长(天)" width="90" align="right">
            <template #default="{ row }">{{ row.max_days || '—' }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- ==================== 人力资源投入分析 ==================== -->
    <div v-show="activeTab === 'workforce'" v-loading="workforceLoading">
      <!-- 销售维度 -->
      <el-card style="margin-bottom: 20px;">
        <template #header><span style="font-weight: bold;">📈 销售维度 — 人力资源投入</span></template>
        <el-table :data="workforceData.salesDimension" stripe>
          <el-table-column prop="user_name" label="销售" width="120" />
          <el-table-column label="在跟客户数" width="110" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="drilldown('sales', row.user_id, 'active_customers')">{{ row.active_customers }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="在跟商机数" width="110" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="drilldown('sales', row.user_id, 'all')">{{ row.active_opportunities }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="已分配售前" width="110" align="center">
            <template #default="{ row }">{{ row.with_presales }}</template>
          </el-table-column>
          <el-table-column label="未分配售前" width="110" align="center">
            <template #default="{ row }">
              <el-button link type="warning" @click="drilldown('sales', row.user_id, 'without_presales')">{{ row.without_presales }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="已分配FDE" width="110" align="center">
            <template #default="{ row }">{{ row.with_fde }}</template>
          </el-table-column>
          <el-table-column label="未分配FDE" width="110" align="center">
            <template #default="{ row }">
              <el-button link type="danger" @click="drilldown('sales', row.user_id, 'without_fde')">{{ row.without_fde }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 售前维度 -->
      <el-card style="margin-bottom: 20px;">
        <template #header><span style="font-weight: bold;">🛠 售前维度 — 人力资源投入</span></template>
        <el-table :data="workforceData.presalesDimension" stripe>
          <el-table-column prop="user_name" label="售前" width="120" />
          <el-table-column label="已分配商机数" width="130" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="drilldown('presales', row.user_id, 'all')">{{ row.assigned_opportunities }}</el-button>
            </template>
          </el-table-column>
          <el-table-column label="已分配FDE" width="110" align="center">
            <template #default="{ row }">{{ row.with_fde }}</template>
          </el-table-column>
          <el-table-column label="未分配FDE" width="110" align="center">
            <template #default="{ row }">
              <el-button link type="danger" @click="drilldown('presales', row.user_id, 'without_fde')">{{ row.without_fde }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- FDE维度 -->
      <el-card>
        <template #header><span style="font-weight: bold;">🔧 FDE维度 — 人力资源投入</span></template>
        <el-table :data="workforceData.fdeDimension" stripe>
          <el-table-column prop="user_name" label="FDE" width="120" />
          <el-table-column label="已分配商机数" width="130" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="drilldown('fde', row.user_id, 'all')">{{ row.assigned_opportunities }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <!-- 钻取商机列表弹窗 -->
    <el-dialog v-model="drilldownVisible" :title="drilldownTitle" width="860px" destroy-on-close>
      <el-table :data="drilldownList" v-loading="drilldownLoading" stripe>
        <el-table-column prop="name" label="商机名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户" width="140" show-overflow-tooltip />
        <el-table-column prop="owner_name" label="销售" width="90" />
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">{{ statusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column prop="presales_names" label="商机售前" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.presales_names || '—' }}</template>
        </el-table-column>
        <el-table-column prop="fde_names" label="商机FDE" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.fde_names || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" align="center" v-if="canAssignFde">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openAssignFde(row)">分配FDE</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 分配FDE弹窗 -->
    <el-dialog v-model="assignFdeVisible" title="分配商机级FDE（支持多人）" width="440px" :close-on-click-modal="false" destroy-on-close>
      <el-form label-width="80px">
        <el-form-item label="商机">{{ assignFdeForm.opp_name }}</el-form-item>
        <el-form-item label="FDE人员">
          <!-- 一个商机可指派多个FDE，人数不限 -->
          <el-select
            v-model="assignFdeForm.user_ids"
            placeholder="请选择FDE人员（可多选）"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            style="width: 100%;"
          >
            <el-option v-for="u in workforceData.fdeUsers" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="assignFdeForm.remark" type="textarea" rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignFdeVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignFdeSubmitting" @click="submitAssignFde">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import { downloadBlobResponse } from '@/utils/download'
import * as echarts from 'echarts'

const activeTab = ref('dashboard')
const exporting = ref(false)
const userRole = ref('')
const canAccessConversion = computed(() => ['admin', 'super_admin', 'operations', 'fde_admin'].includes(userRole.value))
const canAssignFde = computed(() => ['admin', 'super_admin', 'fde_admin'].includes(userRole.value))
const isFdeAdmin = computed(() => userRole.value === 'fde_admin')

const dashboardLoading = ref(false)
const timeLoading = ref(false)
const industryLoading = ref(false)
const regionLoading = ref(false)
const oppLoading = ref(false)
const contractLoading = ref(false)
const paymentLoading = ref(false)
const productLoading = ref(false)
const conversionLoading = ref(false)

// Year toggles
const CY = computed(() => currentYear.value)
const LY = computed(() => currentYear.value - 1)
const currentYear = ref(new Date().getFullYear())

const industryYear = ref(currentYear.value)
const regionYear = ref(currentYear.value)
const oppStatusYear = ref(currentYear.value)
const contractTypeYear = ref(currentYear.value)
const salesYear = ref(currentYear.value)
const indYear = ref(currentYear.value)
const regYear = ref(currentYear.value)
const oppStYear = ref(currentYear.value)
const oppTyYear = ref(currentYear.value)
const ctYear = ref(currentYear.value)
const pmYear = ref(currentYear.value)
const pdYear = ref(currentYear.value)

// Dashboard data
const coreMetrics = reactive({})
const thisYearSummary = reactive({})
const lastYearSummary = reactive({})
const industryCurrent = ref([])
const industryLast = ref([])
const regionCurrent = ref([])
const regionLast = ref([])
const oppStatusCurrent = ref([])
const oppStatusLast = ref([])
const oppTypeCurrent = ref([])
const oppTypeLast = ref([])
const contractTypeCurrent = ref([])
const contractTypeLast = ref([])
const paymentMethodCurrent = ref([])
const paymentMethodLast = ref([])
const salesRankingCurrent = ref([])
const salesRankingLast = ref([])

// Time trend
const timeData = reactive({})

// Industry standalone
const indCurrent = ref([])
const indLast = ref([])

// Region standalone
const regCurrent = ref([])
const regLast = ref([])

// Opportunity standalone
const oppData = reactive({})

// Contract standalone
const ctCurrent = ref([])
const ctLast = ref([])

// Payment standalone
const paymentData = reactive({})

// Product standalone
const productData = reactive({})

// 商机转化时间
const convData = reactive({})
const stageDurationChart = ref(null)

// 人力资源投入分析
const workforceLoading = ref(false)
const workforceData = reactive({ salesDimension: [], presalesDimension: [], fdeDimension: [], presalesUsers: [], fdeUsers: [] })
const drilldownVisible = ref(false)
const drilldownLoading = ref(false)
const drilldownList = ref([])
const drilldownTitle = ref('')
const currentDrilldown = reactive({ dimension: '', userId: '', metric: '' })
const assignFdeVisible = ref(false)
const assignFdeSubmitting = ref(false)
const assignFdeForm = reactive({ opp_id: '', opp_name: '', user_id: '', remark: '' })

const paymentTrendChart = ref(null)
const timeChart = ref(null)

const fmt = (v) => (v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })

const statusLabel = (s) => ({ potential:'潜在', technical:'技术交流', poc:'POC', project:'立项', bidding:'招投标', contracting:'合同中', signed:'已签', lost:'已丢失' }[s] || s || '-')
const oppTypeLabel = (t) => ({ new_project:'新项目', renewal:'续签', maintenance:'维保', other:'其他' }[t] || t || '-')
const methodLabel = (m) => ({ bank_transfer:'银行转账', check:'支票', cash:'现金', bill:'承兑汇票', other:'其他' }[m] || m || '-')

// Computed table data based on year toggle
const industryTableData = computed(() => industryYear.value === currentYear.value ? industryCurrent.value : industryLast.value)
const regionTableData = computed(() => regionYear.value === currentYear.value ? regionCurrent.value : regionLast.value)
const oppStatusTableData = computed(() => oppStatusYear.value === currentYear.value ? oppStatusCurrent.value : oppStatusLast.value)
const contractTypeTableData = computed(() => contractTypeYear.value === currentYear.value ? contractTypeCurrent.value : contractTypeLast.value)
const salesTableData = computed(() => salesYear.value === currentYear.value ? salesRankingCurrent.value : salesRankingLast.value)
const indTableData = computed(() => indYear.value === currentYear.value ? indCurrent.value : indLast.value)
const regTableData = computed(() => regYear.value === currentYear.value ? regCurrent.value : regLast.value)
const oppStTableData = computed(() => oppStYear.value === currentYear.value ? oppData.byStatusCurrent : (oppData.byStatusLast || []))
const oppTyTableData = computed(() => oppTyYear.value === currentYear.value ? oppData.byTypeCurrent : (oppData.byTypeLast || []))
const ctTableData = computed(() => ctYear.value === currentYear.value ? ctCurrent.value : ctLast.value)
const pmTableData = computed(() => pmYear.value === currentYear.value ? paymentData.byMethodCurrent : (paymentData.byMethodLast || []))
const pdTableData = computed(() => pdYear.value === currentYear.value ? productData.cyData : (productData.lyData || []))

const yearCompareData = computed(() => [
  { name: '回款笔数', ty: thisYearSummary.payment_count || 0, ly: lastYearSummary.payment_count || 0, isAmt: false },
  { name: '回款金额', ty: thisYearSummary.payment_amount || 0, ly: lastYearSummary.payment_amount || 0, isAmt: true },
  { name: '合同笔数', ty: thisYearSummary.contract_count || 0, ly: lastYearSummary.contract_count || 0, isAmt: false },
  { name: '合同金额', ty: thisYearSummary.contract_amount || 0, ly: lastYearSummary.contract_amount || 0, isAmt: true },
])

// =====================================================
// Load dashboard
// =====================================================
const loadDashboard = async () => {
  dashboardLoading.value = true
  try {
    const { data } = await request.get('/api/stats/dashboard')
    userRole.value = data.userRole
    currentYear.value = data.currentYear

    Object.assign(coreMetrics, data.coreMetrics || {})
    Object.assign(thisYearSummary, data.thisYearSummary || {})
    Object.assign(lastYearSummary, data.lastYearSummary || {})
    industryCurrent.value = data.industryCurrent || []
    industryLast.value = data.industryLast || []
    regionCurrent.value = data.regionCurrent || []
    regionLast.value = data.regionLast || []
    oppStatusCurrent.value = data.oppStatusCurrent || []
    oppStatusLast.value = data.oppStatusLast || []
    oppTypeCurrent.value = data.oppTypeCurrent || []
    oppTypeLast.value = data.oppTypeLast || []
    contractTypeCurrent.value = data.contractTypeCurrent || []
    contractTypeLast.value = data.contractTypeLast || []
    paymentMethodCurrent.value = data.paymentMethodCurrent || []
    paymentMethodLast.value = data.paymentMethodLast || []
    salesRankingCurrent.value = data.salesRankingCurrent || []
    salesRankingLast.value = data.salesRankingLast || []

    await nextTick()
    renderPaymentTrendChart(data.currentYearMonthly, data.lastYearMonthly)

    // 同时加载产品分析数据（综合看板也显示产品分析）
    if (!productData.cyData?.length) {
      loadProduct()
    }
  } catch (e) {
    console.error('加载看板失败:', e)
  } finally {
    dashboardLoading.value = false
  }
}

// =====================================================
// Load time trend
// =====================================================
const loadTimeTrend = async () => {
  timeLoading.value = true
  try {
    const { data } = await request.get('/api/stats/time-trend')
    Object.assign(timeData, data)
    await nextTick()
    renderTimeChart(data.currentYearMonthly, data.lastYearMonthly)
  } catch (e) {
    console.error('加载时间趋势失败:', e)
  } finally {
    timeLoading.value = false
  }
}

// =====================================================
// Load opportunity standalone
// =====================================================
const loadOpportunity = async () => {
  oppLoading.value = true
  try {
    const { data } = await request.get('/api/stats/opportunity-analysis')
    Object.assign(oppData, data)
  } catch (e) {
    console.error('加载商机失败:', e)
  } finally {
    oppLoading.value = false
  }
}

// =====================================================
// Load contract standalone
// =====================================================
const loadContract = async () => {
  contractLoading.value = true
  try {
    const { data } = await request.get('/api/stats/contract-analysis')
    ctCurrent.value = data.cyData || []
    ctLast.value = data.lyData || []
  } catch (e) {
    console.error('加载合同失败:', e)
  } finally {
    contractLoading.value = false
  }
}

// =====================================================
// Load payment standalone
// =====================================================
const loadPayment = async () => {
  paymentLoading.value = true
  try {
    const { data } = await request.get('/api/stats/payment-analysis')
    currentYear.value = data.currentYear
    paymentData.byMethodCurrent = data.currentYearByMethod || []
    paymentData.byMethodLast = data.lastYearByMethod || []
    paymentData.currentYearSummary = data.currentYearSummary || { count: 0, total_amount: 0 }
    paymentData.lastYearSummary = data.lastYearSummary || { count: 0, total_amount: 0 }
  } catch (e) {
    console.error('加载回款失败:', e)
  } finally {
    paymentLoading.value = false
  }
}

// =====================================================
// Load product standalone
// =====================================================
const loadProduct = async () => {
  productLoading.value = true
  try {
    const { data } = await request.get('/api/stats/product-analysis')
    Object.assign(productData, data)
  } catch (e) {
    console.error('加载产品分析失败:', e)
  } finally {
    productLoading.value = false
  }
}

// =====================================================
// 加载商机转化时间
// =====================================================
const loadConversion = async () => {
  conversionLoading.value = true
  try {
    const { data } = await request.get('/api/stats/opportunity-conversion-time')
    Object.assign(convData, data)
    await nextTick()
    renderStageDurationChart(data.stageDurations)
  } catch (e) {
    console.error('加载商机转化周期分析失败:', e)
  } finally {
    conversionLoading.value = false
  }
}

const renderStageDurationChart = (stages) => {
  if (!stageDurationChart.value || !stages || stages.length === 0) return
  const chart = echarts.init(stageDurationChart.value)

  // 预设阶段颜色
  const presetColors = {
    'potential→technical': '#3370ff',
    'technical→poc': '#34c724',
    'poc→project': '#ff8800',
    'project→bidding': '#f54a45',
    'bidding→contracting': '#8f959e',
    'contracting→signed': '#7f3bf5'
  }

  // 预设标签
  const presetLabels = {
    'potential→technical': '潜在→技术交流',
    'technical→poc': '技术交流→POC',
    'poc→project': 'POC→立项',
    'project→bidding': '立项→招投标',
    'bidding→contracting': '招投标→合同中',
    'contracting→signed': '合同中→已签'
  }

  // 从实际数据中提取所有阶段转换 + 按产品分组
  const stageKeySet = new Set()
  const signedProducts = []
  const estimatedProducts = []
  const productSet = new Set()
  const productMap = {}

  stages.forEach(s => {
    const p = s.product_name || '未指定'
    const key = `${s.from_status}→${s.to_status}`
    stageKeySet.add(key)

    if (p.includes('(预估)')) {
      if (!estimatedProducts.includes(p)) estimatedProducts.push(p)
    } else {
      if (!productSet.has(p)) { productSet.add(p); signedProducts.push(p) }
    }

    if (!productMap[p]) productMap[p] = {}
    productMap[p][key] = {
      avg_days: parseFloat(s.avg_days) || 0,
      transition_count: s.transition_count || 0,
      isEstimated: s.isEstimated || false
    }
  })

  // 阶段 key 必须在所有数据处理完成后才提取
  const stageKeys = [...stageKeySet]
  const allProducts = [...signedProducts, ...estimatedProducts]

  // 颜色池（超出预设时用）
  const colorPool = ['#3370ff','#14c0ff','#00d6b9','#34c724','#ffc60a','#ff8800','#f54a45','#7f3bf5','#04b49c','#ff8110']
  let colorIdx = 0
  const getColor = (key) => {
    if (presetColors[key]) return presetColors[key]
    return colorPool[colorIdx++ % colorPool.length]
  }

  // 计算每个产品的总天数
  const productTotals = allProducts.map(p => {
    let total = 0
    stageKeys.forEach(key => { total += (productMap[p]?.[key]?.avg_days || 0) })
    return total
  })

  // 构建堆叠系列 — 每个阶段一个 series
  const series = stageKeys.map(key => {
    const color = getColor(key)
    const parts = key.split('→')
    const displayName = presetLabels[key] || `${statusLabel(parts[0])}→${statusLabel(parts[1])}`

    // 预计算每个产品的样式
    const barData = allProducts.map(p => {
      const info = productMap[p]?.[key]
      if (!info || info.avg_days === 0) return 0
      if (info.isEstimated) {
        // 预估数据：半透明 + 虚线边框
        return {
          value: info.avg_days,
          itemStyle: {
            color: color + '55',
            borderColor: color,
            borderWidth: 2,
            borderType: 'dashed'
          }
        }
      }
      return {
        value: info.avg_days,
        itemStyle: { color: color }
      }
    })

    return {
      name: displayName,
      type: 'bar',
      stack: 'total',
      barMaxWidth: 40,
      label: {
        show: true,
        position: 'inside',
        formatter: (p) => {
          if (!p.value || p.value === 0) return ''
          return `${p.value}天`
        },
        fontSize: 11,
        color: '#fff',
        fontWeight: 'bold'
      },
      data: barData
    }
  })

  // 自适应高度
  const chartHeight = Math.max(300, allProducts.length * 55 + 100)
  stageDurationChart.value.style.height = chartHeight + 'px'
  chart.resize()

  chart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        if (!params || !params.length) return ''
        const name = params[0].axisValue
        const total = productTotals[allProducts.indexOf(name)]
        const isEst = name.includes('(预估)')
        let html = `<b>${name}</b> ${isEst ? '<span style="color:#ff8800">(预估)</span>' : ''}<br/>总周期: <b>${total}天</b><br/><hr style="margin:4px 0;border:none;border-top:1px solid #ccc;">`
        params.forEach(p => {
          if (p.value > 0) {
            // 从 seriesName 反查 stage key
            const key = Object.keys(presetLabels).find(k => presetLabels[k] === p.seriesName) || p.seriesName
            const info = productMap[allProducts[p.dataIndex]]?.[key]
            const estTag = info && info.isEstimated ? ' <span style="color:#ff8800;font-size:10px">预估</span>' : ''
            html += `${p.marker}${p.seriesName}: <b>${p.value}天</b>${estTag}<br/>`
          }
        })
        return html
      }
    },
    legend: {
      data: series.map(s => s.name),
      top: 5,
      textStyle: { fontSize: 11 }
    },
    grid: { left: '3%', right: '8%', bottom: '3%', top: '55', containLabel: true },
    xAxis: {
      type: 'value',
      name: '天数',
      axisLabel: { formatter: '{value}天' }
    },
    yAxis: {
      type: 'category',
      data: allProducts,
      axisLabel: {
        fontSize: 11,
        fontWeight: (v) => v.includes('(预估)') ? 'normal' : 'bold',
        color: (v) => v.includes('(预估)') ? '#ff8800' : '#1f2329'
      },
      axisTick: { show: false }
    },
    series: [
      ...series,
      {
        name: '总周期',
        type: 'bar',
        stack: 'total',
        barMaxWidth: 40,
        label: {
          show: true,
          position: 'right',
          formatter: (p) => {
            const total = productTotals[p.dataIndex]
            return total > 0 ? `总计 ${total}天` : ''
          },
          fontSize: 12,
          fontWeight: 'bold',
          color: '#1f2329',
          offset: [10, 0]
        },
        itemStyle: { color: 'transparent' },
        data: allProducts.map(() => 0),
        silent: true
      }
    ]
  })
}

// =====================================================
// Charts
// =====================================================
const renderPaymentTrendChart = (cy, ly) => {
  if (!paymentTrendChart.value) return
  const chart = echarts.init(paymentTrendChart.value)
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`)
  const cyAmt = new Array(12).fill(0)
  const lyAmt = new Array(12).fill(0)
  cy?.forEach(i => { cyAmt[i.month - 1] = i.payment_amount || 0 })
  ly?.forEach(i => { lyAmt[i.month - 1] = i.payment_amount || 0 })
  chart.setOption({
    tooltip: { trigger: 'axis', formatter: '{b}<br/>{a}: ¥{c}' },
    legend: { data: [`${currentYear.value}年回款`, `${currentYear.value - 1}年回款`] },
    xAxis: { type: 'category', data: months },
    yAxis: { type: 'value', axisLabel: { formatter: v => '¥' + (v / 10000).toFixed(0) + '万' } },
    series: [
      { name: `${currentYear.value}年回款`, type: 'bar', data: cyAmt, itemStyle: { color: '#3370ff' } },
      { name: `${currentYear.value - 1}年回款`, type: 'bar', data: lyAmt, itemStyle: { color: '#8f959e' } }
    ]
  })
}

const renderTimeChart = (cy, ly) => {
  if (!timeChart.value) return
  const chart = echarts.init(timeChart.value)
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`)
  const cyAmt = new Array(12).fill(0)
  const lyAmt = new Array(12).fill(0)
  cy?.forEach(i => { cyAmt[i.month - 1] = i.payment_amount || 0 })
  ly?.forEach(i => { lyAmt[i.month - 1] = i.payment_amount || 0 })
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: [`${currentYear.value}年`, `${currentYear.value - 1}年`] },
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
    xAxis: { type: 'category', data: months },
    yAxis: { type: 'value', axisLabel: { formatter: v => '¥' + (v / 10000).toFixed(0) + '万' } },
    series: [
      { name: `${currentYear.value}年`, type: 'line', smooth: true, data: cyAmt, itemStyle: { color: '#3370ff' }, areaStyle: { color: 'rgba(51,112,255,0.1)' } },
      { name: `${currentYear.value - 1}年`, type: 'line', smooth: true, data: lyAmt, itemStyle: { color: '#8f959e' }, areaStyle: { color: 'rgba(144,147,153,0.1)' } }
    ]
  })
}

// =====================================================
// Tab click
// =====================================================
const handleTabClick = (tab) => {
  const n = tab.paneName
  if (n === 'timeTrend' && !timeData.currentYearMonthly?.length) loadTimeTrend()
  if (n === 'opportunity' && !oppData.byStatusCurrent?.length) loadOpportunity()
  if (n === 'contract' && !ctCurrent.value.length) loadContract()
  if (n === 'payment' && !paymentData.byMethodCurrent?.length) loadPayment()
  if (n === 'product' && !productData.cyData?.length) loadProduct()
  if (n === 'conversionTime' && !convData.overview?.total_opp) loadConversion()
  if (n === 'workforce' && !workforceData.salesDimension.length) loadWorkforce()
}

// =====================================================
// 人力资源投入分析
// =====================================================
const loadWorkforce = async () => {
  workforceLoading.value = true
  try {
    const { data } = await request.get('/api/stats/workforce-analysis')
    workforceData.salesDimension = data.salesDimension || []
    workforceData.presalesDimension = data.presalesDimension || []
    workforceData.fdeDimension = data.fdeDimension || []
    workforceData.presalesUsers = data.presalesUsers || []
    workforceData.fdeUsers = data.fdeUsers || []
  } catch (e) {
    console.error('加载人力资源投入分析失败:', e)
  } finally {
    workforceLoading.value = false
  }
}

const drilldown = async (dimension, userId, metric) => {
  // 保存当前钻取参数，以便分配 FDE 后刷新
  currentDrilldown.dimension = dimension
  currentDrilldown.userId = userId
  currentDrilldown.metric = metric
  drilldownVisible.value = true
  drilldownLoading.value = true
  drilldownList.value = []
  const dimLabels = { sales: '销售', presales: '售前', fde: 'FDE' }
  const metricLabels = {
    all: '全部商机', active_customers: '在跟客户',
    without_presales: '未分配售前', without_fde: '未分配FDE',
    with_presales_no_fde: '有售前无FDE'
  }
  const userName = dimension === 'sales'
    ? workforceData.salesDimension.find(s => s.user_id === userId)?.user_name || ''
    : dimension === 'presales'
      ? workforceData.presalesDimension.find(p => p.user_id === userId)?.user_name || ''
      : workforceData.fdeDimension.find(f => f.user_id === userId)?.user_name || ''
  drilldownTitle.value = `${dimLabels[dimension]}（${userName}）— ${metricLabels[metric] || '全部'}`
  try {
    const { data } = await request.get('/api/stats/workforce-analysis/drilldown', {
      params: { dimension, user_id: userId, metric }
    })
    drilldownList.value = data.data || []
  } catch (e) {
    console.error('钻取商机列表失败:', e)
  } finally {
    drilldownLoading.value = false
  }
}

const openAssignFde = (opp) => {
  assignFdeForm.opp_id = opp.id
  assignFdeForm.opp_name = opp.name
  assignFdeForm.user_id = opp.fde_names ? '' : (workforceData.fdeUsers[0]?.id || '')
  assignFdeForm.remark = ''
  assignFdeVisible.value = true
}

const submitAssignFde = async () => {
  if (!assignFdeForm.user_id) return
  assignFdeSubmitting.value = true
  try {
    await request.post(`/api/opportunities/${assignFdeForm.opp_id}/assignments`, {
      assignment_type: 'fde',
      user_id: assignFdeForm.user_id,
      remark: assignFdeForm.remark
    })
    assignFdeVisible.value = false
    // 刷新分析数据
    await loadWorkforce()
    // 重新触发当前钻取
    if (currentDrilldown.dimension) {
      await drilldown(currentDrilldown.dimension, currentDrilldown.userId, currentDrilldown.metric)
    }
  } catch (e) {
    console.error('分配FDE失败:', e)
  } finally {
    assignFdeSubmitting.value = false
  }
}

const exportStatistics = async () => {
  if (activeTab.value === 'conversionTime') return
  exporting.value = true
  try {
    const response = await request.get('/api/stats/export', {
      params: { section: activeTab.value },
      responseType: 'blob'
    })
    downloadBlobResponse(response, `数据统计_${activeTab.value}_${new Date().toISOString().slice(0, 10)}.csv`)
  } finally {
    exporting.value = false
  }
}

onMounted(() => loadDashboard())
</script>

<style scoped>
.statistics {
  padding: 0;
}

.statistics-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.statistics-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2329;
}

.metric-card {
  text-align: center;
}

.metric-value {
  font-size: 28px;
  font-weight: bold;
  margin-bottom: var(--spacing-xs);
}

.metric-label {
  font-size: 14px;
  color: #646a73;
}

.metric-sub {
  font-size: 12px;
  color: #8f959e;
  margin-top: var(--spacing-xs);
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

:deep(.el-tabs__header) {
  margin-bottom: var(--spacing-xl);
}
</style>
