<template>
  <div class="weekly-meeting">
    <h1>开周会</h1>
    
    <el-card class="section-card">
      <template #header>
        <div class="section-header">
          <div>
            <div class="card-title">销售季度签约管道</div>
            <div class="card-subtitle">{{ opportunitySubtitle }}</div>
          </div>
          <div class="quarter-switcher">
            <el-radio-group v-model="opportunityPeriodType" size="small" @change="handleOpportunityPeriodTypeChange">
              <el-radio-button value="quarter">季度</el-radio-button>
              <el-radio-button value="year">年度</el-radio-button>
            </el-radio-group>
            <el-button :icon="ArrowLeft" :aria-label="opportunityPeriodType === 'year' ? '上一年' : '上一季度'" @click="changeOpportunityPeriod(-1)" />
            <span class="quarter-label">{{ opportunityPeriodLabel }}</span>
            <el-button :icon="ArrowRight" :aria-label="opportunityPeriodType === 'year' ? '下一年' : '下一季度'" @click="changeOpportunityPeriod(1)" />
            <el-button :disabled="isCurrentOpportunityPeriod" @click="goToCurrentOpportunityPeriod">{{ opportunityPeriodType === 'year' ? '本年' : '本季度' }}</el-button>
          </div>
        </div>
      </template>
      <el-table
        v-loading="opportunityStatsLoading"
        :data="opportunityStatsBySales"
        style="width: 100%"
        :header-cell-style="{background: '#f8f9fa', color: '#646a73'}"
      >
        <el-table-column prop="sales_name" label="销售" min-width="120" fixed="left" />
        <el-table-column prop="total_count" label="应签商机数" min-width="105" align="center" />
        <el-table-column prop="active_count" label="在跟商机数" min-width="105" align="center" />
        <el-table-column prop="signed" label="已签商机数" min-width="105" align="center" />
        <el-table-column label="完成率" min-width="150" align="center">
          <template #default="{ row }">
            <div class="completion-rate">
              <el-progress :percentage="row.completion_rate" :stroke-width="8" :show-text="false" />
              <strong>{{ formatRate(row.completion_rate) }}</strong>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="potential" label="潜在" width="72" align="center" />
        <el-table-column prop="technical" label="技术交流" width="88" align="center" />
        <el-table-column prop="poc" label="POC" width="68" align="center" />
        <el-table-column prop="project" label="立项" width="72" align="center" />
        <el-table-column prop="bidding" label="招投标" width="82" align="center" />
        <el-table-column prop="contracting" label="合同中" width="82" align="center" />
        <el-table-column prop="lost" label="已终止" width="82" align="center" />
      </el-table>
    </el-card>

    <el-card class="section-card">
      <template #header>
        <div class="section-header">
          <div>
            <div class="card-title">销售每周进展</div>
            <div class="card-subtitle">{{ weeklyProgressRange }}</div>
          </div>
          <div class="quarter-switcher">
            <el-radio-group v-model="weeklyProgressPeriodType" size="small" @change="handleWeeklyProgressPeriodTypeChange">
              <el-radio-button value="quarter">季度</el-radio-button>
              <el-radio-button value="year">年度</el-radio-button>
            </el-radio-group>
            <el-button :icon="ArrowLeft" :aria-label="weeklyProgressPeriodType === 'year' ? '上一年' : '上一季度'" @click="changeWeeklyProgressPeriod(-1)" />
            <span class="quarter-label">{{ weeklyProgressPeriodLabel }}</span>
            <el-button :icon="ArrowRight" :aria-label="weeklyProgressPeriodType === 'year' ? '下一年' : '下一季度'" @click="changeWeeklyProgressPeriod(1)" />
            <el-button :disabled="isCurrentWeeklyProgressPeriod" @click="goToCurrentWeeklyProgressPeriod">{{ weeklyProgressPeriodType === 'year' ? '本年' : '本季度' }}</el-button>
          </div>
        </div>
      </template>
      <!-- 折线图：每个销售一条线，按新增商机/签约商机/跟进次数/新增合同展示所选周期数据 -->
      <div
        ref="weeklyProgressChart"
        class="weekly-progress-chart"
        v-loading="weeklyProgressLoading"
      ></div>
    </el-card>

    <el-card class="section-card">
      <template #header>
        <div class="section-header">
          <div>
            <div class="card-title">销售合同与待回款</div>
            <div class="card-subtitle">按年统计：合同按签订日期、待回款按计划回款日期</div>
          </div>
          <div class="contract-period-toolbar">
            <div class="period-switcher">
              <el-button :icon="ArrowLeft" aria-label="上一年" @click="changeContractPeriod(-1)" />
              <span class="period-label">{{ contractPeriodLabel }}</span>
              <el-button :icon="ArrowRight" aria-label="下一年" @click="changeContractPeriod(1)" />
              <el-button :disabled="isCurrentContractPeriod" @click="goToCurrentContractPeriod">本年</el-button>
            </div>
          </div>
        </div>
      </template>
      <el-table
        v-loading="contractStatsLoading"
        :data="contractAndPaymentStatsBySales"
        style="width: 100%"
        :header-cell-style="{background: '#f8f9fa', color: '#646a73'}"
      >
        <el-table-column prop="sales_name" label="销售" min-width="180" />
        <el-table-column prop="contract_count" label="合同数量" min-width="120" align="center" />
        <el-table-column prop="pending_payment_count" label="待回款数量" min-width="130" align="center" />
      </el-table>
    </el-card>

    <!-- 第三行：可筛选的商机数据展示 -->
    <el-card class="section-card">
      <template #header>
        <div class="section-header">
          <div>
            <div class="card-title">商机数据</div>
            <div class="card-subtitle">{{ opportunityPeriodLabel }} · {{ opportunityListSubtitle }}</div>
          </div>
        </div>
      </template>
      <!-- 筛选条件 -->
      <div class="filter-section">
        <el-form :inline="true" :model="filterForm" class="demo-form-inline">
          <el-form-item label="客户名称">
            <el-input
              v-model="filterForm.customer_name"
              clearable
              placeholder="输入客户名称搜索"
              style="width: 220px"
              @keyup.enter="applyFilters"
            />
          </el-form-item>
          <el-form-item label="商机状态">
            <el-select 
              v-model="filterForm.status" 
              multiple 
              placeholder="请选择商机状态" 
              style="width: 300px"
            >
              <el-option label="潜在" value="potential"></el-option>
              <el-option label="技术交流" value="technical"></el-option>
              <el-option label="POC" value="poc"></el-option>
              <el-option label="立项" value="project"></el-option>
              <el-option label="招投标" value="bidding"></el-option>
              <el-option label="合同中" value="contracting"></el-option>
              <el-option label="已签" value="signed"></el-option>
              <el-option label="已丢失" value="lost"></el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="销售">
            <el-select 
              v-model="filterForm.owner_id" 
              placeholder="请选择销售" 
              style="width: 200px"
            >
              <el-option 
                v-for="user in salesUsers" 
                :key="user.id" 
                :label="user.name" 
                :value="user.id"
              ></el-option>
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="applyFilters">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 商机表格 -->
      <el-table 
        :data="filterableOpportunities" 
        style="width: 100%"
        :header-cell-style="{background: '#f8f9fa', color: '#646a73'}"
      >
        <el-table-column prop="opportunity_name" label="商机名称" min-width="190" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="opportunity_type" label="商机类型" min-width="100">
          <template #default="{ row }">{{ getOpportunityTypeText(row.opportunity_type) }}</template>
        </el-table-column>
        <el-table-column prop="created_date" label="创建时间" min-width="110" />
        <el-table-column prop="expected_sign_date" label="预计签约时间" min-width="120" />
        <!-- 季度口径下展示两列：季末快照状态（用于与上方签约管道对账）+ 当前最新状态 -->
        <el-table-column :label="opportunityPeriodType === 'year' ? '状态' : '季末状态'" min-width="95">
          <template #default="{ row }">
            <el-tag 
              :type="getStatusTagType(row.snapshot_status || row.status)" 
              size="small"
            >
              {{ getStatusText(row.snapshot_status || row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="opportunityPeriodType === 'quarter'" label="当前状态" min-width="95">
          <template #default="{ row }">
            <el-tag 
              :type="getStatusTagType(row.status)" 
              size="small"
              effect="plain"
            >
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="owner_name" label="负责销售" min-width="110" show-overflow-tooltip />
        <el-table-column label="售前" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ row.presales_names || '未指派' }}</template>
        </el-table-column>
        <el-table-column label="FDE" min-width="110" show-overflow-tooltip>
          <template #default="{ row }">{{ row.fde_names || '未指派' }}</template>
        </el-table-column>
        <el-table-column prop="followup_count" label="跟进次数" min-width="90" align="center" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="showFollowups(row)">跟进记录</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-container">
        <el-pagination
          layout="prev, pager, next"
          :total="totalOpportunities"
          :page-size="10"
          :current-page="currentPage"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>

    <!-- 跟进记录对话框 -->
    <el-dialog
      v-model="followupDialogVisible"
      :title="`${currentOpportunityName} - 跟进记录`"
      width="800px"
    >
      <div v-if="followupList.length === 0" class="empty-tip">暂无跟进记录</div>
      <div v-else class="followup-list">
        <div v-for="(item, index) in followupList" :key="item.id || index" class="followup-item">
          <div class="followup-header">
            <span class="followup-user">{{ item.followup_user_name || '未知' }}</span>
            <span class="followup-type">{{ getTypeText(item.type) }}</span>
            <span class="followup-time">{{ formatTime(item.followup_time) }}</span>
          </div>
          <div class="followup-content">{{ item.content || '无内容' }}</div>
          <div v-if="item.result" class="followup-result">
            <span class="label">跟进结果：</span>{{ item.result }}
          </div>
          <div v-if="item.next_followup_at" class="followup-next">
            <span class="label">下次跟进：</span>{{ formatTime(item.next_followup_at) }} {{ item.next_followup_content || '' }}
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import * as echarts from 'echarts';
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue';
import { getWeeklyMeetingOpportunitiesByStatus, getWeeklyMeetingContractsAndPayments, getWeeklyMeetingWeeklyProgress, getWeeklyMeetingFilterableOpportunities, getFollowupsByOpportunity } from '@/utils/api';

export default {
  name: 'WeeklyMeeting',
  setup() {
    // 第一行数据
    const opportunityStatsBySales = ref([]);
    const opportunityStatsLoading = ref(false);
    const now = new Date();
    const currentQuarter = {
      year: now.getFullYear(),
      quarter: Math.floor(now.getMonth() / 3) + 1
    };
    const selectedQuarter = reactive({ ...currentQuarter });
    const quarterLabel = computed(() => `${selectedQuarter.year} 年第 ${selectedQuarter.quarter} 季度`);
    const isCurrentQuarter = computed(() =>
      selectedQuarter.year === currentQuarter.year && selectedQuarter.quarter === currentQuarter.quarter
    );

    // 签约管道统计维度：quarter（按季度，默认）| year（按年）
    const opportunityPeriodType = ref('quarter');
    // 副标题文案随维度自适应：
    // 季度=累计快照（统计季末前创建的全部商机，状态取季末时点）；年度=仅当年新建（状态取最新）
    const opportunitySubtitle = computed(() =>
      opportunityPeriodType.value === 'year'
        ? '按商机创建时间归属年度（仅当年新建），状态取当前最新；完成率 = 已签商机数 ÷ 应签商机数（应签不含已终止）'
        : '按商机创建时间累计至季末，状态取季末历史快照；完成率 = 已签商机数 ÷ 应签商机数（应签不含已终止）'
    );
    // 「商机数据」列表副标题：与上方签约管道同口径
    const opportunityListSubtitle = computed(() =>
      opportunityPeriodType.value === 'year'
        ? '按商机创建时间归属（仅当年新建），状态为当前最新，与上方签约管道同口径'
        : '按商机创建时间归属（累计至季末），季末状态为历史快照，与上方签约管道同口径'
    );
    // 切换器中间标签：年度显示「YYYY 年」，季度沿用原季度标签
    const opportunityPeriodLabel = computed(() =>
      opportunityPeriodType.value === 'year' ? `${selectedQuarter.year} 年` : quarterLabel.value
    );
    // 是否为当前周期（用于禁用「本年/本季度」按钮）
    const isCurrentOpportunityPeriod = computed(() =>
      opportunityPeriodType.value === 'year'
        ? selectedQuarter.year === currentQuarter.year
        : isCurrentQuarter.value
    );
    
    // 第二行数据
    const contractAndPaymentStatsBySales = ref([]);
    const contractStatsLoading = ref(false);
    // 统计口径固定为按年
    const contractPeriod = reactive({
      type: 'year',
      year: now.getFullYear()
    });
    const contractPeriodLabel = computed(() => `${contractPeriod.year} 年`);
    const isCurrentContractPeriod = computed(() => contractPeriod.year === now.getFullYear());
    const weeklyProgress = ref([]);
    const weeklyProgressLoading = ref(false);
    // 后端返回的周期区间信息（start/end 为含当天的闭区间）
    const weeklyProgressPeriodInfo = ref({});
    // 销售每周进展折线图容器
    const weeklyProgressChart = ref(null);
    // 统计维度：quarter（按季度，默认）| year（按年），默认落在当前季度
    const weeklyProgressPeriodType = ref('quarter');
    // 本卡片独立的周期状态，不与「销售季度签约管道」共用，避免相互影响
    const weeklyProgressPeriod = reactive({ ...currentQuarter });
    // 切换器中间标签：年度显示「YYYY 年」，季度显示「YYYY 年第 N 季度」
    const weeklyProgressPeriodLabel = computed(() =>
      weeklyProgressPeriodType.value === 'year'
        ? `${weeklyProgressPeriod.year} 年`
        : `${weeklyProgressPeriod.year} 年第 ${weeklyProgressPeriod.quarter} 季度`
    );
    // 是否为当前周期（用于禁用「本年/本季度」按钮）
    const isCurrentWeeklyProgressPeriod = computed(() =>
      weeklyProgressPeriodType.value === 'year'
        ? weeklyProgressPeriod.year === currentQuarter.year
        : weeklyProgressPeriod.year === currentQuarter.year && weeklyProgressPeriod.quarter === currentQuarter.quarter
    );
    const weeklyProgressRange = computed(() => {
      const info = weeklyProgressPeriodInfo.value;
      if (!info.start) return '按所选周期统计';
      // 仅展示所选周期区间（上一周期/变化数据不展示）
      return `${info.start} 至 ${info.end}`;
    });

    // 组装「销售每周进展」的周期参数：年度模式只传 year，季度模式传 year + quarter
    const buildWeeklyProgressParams = () => {
      const params = { period_type: weeklyProgressPeriodType.value, year: weeklyProgressPeriod.year };
      if (weeklyProgressPeriodType.value === 'quarter') {
        params.quarter = weeklyProgressPeriod.quarter;
      }
      return params;
    };

    // 按维度切换周期：年度模式按年 ±1，季度模式按季度 ±1（跨年自动进位）
    const changeWeeklyProgressPeriod = (offset) => {
      if (weeklyProgressPeriodType.value === 'year') {
        weeklyProgressPeriod.year += offset;
      } else {
        const quarterIndex = weeklyProgressPeriod.year * 4 + weeklyProgressPeriod.quarter - 1 + offset;
        weeklyProgressPeriod.year = Math.floor(quarterIndex / 4);
        weeklyProgressPeriod.quarter = quarterIndex % 4 + 1;
      }
      fetchWeeklyProgress();
    };

    // 回到当前周期：年度模式回到本年，季度模式回到本季度
    const goToCurrentWeeklyProgressPeriod = () => {
      weeklyProgressPeriod.year = currentQuarter.year;
      weeklyProgressPeriod.quarter = currentQuarter.quarter;
      fetchWeeklyProgress();
    };

    // 切换统计维度（季度/年度）后重新拉取数据
    const handleWeeklyProgressPeriodTypeChange = () => {
      fetchWeeklyProgress();
    };
    
    // 第三行数据
    const filterableOpportunities = ref([]);
    const totalOpportunities = ref(0);
    const currentPage = ref(1);
    
    // 筛选条件
    const filterForm = reactive({
      customer_name: '',
      status: [],
      owner_id: ''
    });
    
    // 销售用户列表
    const salesUsers = ref([]);

    // 跟进记录对话框
    const followupDialogVisible = ref(false);
    const currentOpportunityName = ref('');
    const followupList = ref([]);

    // 组装当前统计周期参数：年度模式只传 year，季度模式传 year + quarter。
    // 「销售季度签约管道」与「商机数据」列表共用，保证上下两块数据口径一致。
    const buildPeriodParams = () => {
      const params = { period_type: opportunityPeriodType.value, year: selectedQuarter.year };
      if (opportunityPeriodType.value === 'quarter') {
        params.quarter = selectedQuarter.quarter;
      }
      return params;
    };

    // 获取按销售统计各状态商机数量
    const fetchOpportunityStatsBySales = async () => {
      opportunityStatsLoading.value = true;
      try {
        const response = await getWeeklyMeetingOpportunitiesByStatus(buildPeriodParams());
        const responseData = response.data?.data || response.data;
        if (responseData && typeof responseData === 'object') {
          // 后端以 owner_id 为 key 返回，sales_name 从字段中取（不再用 key 当姓名）
          const statsArray = Object.keys(responseData).map(key => {
            const stat = responseData[key];
            return {
              sales_name: stat.sales_name || key,
              id: stat.id || key,
              potential: stat.potential || 0,
              technical: stat.technical || 0,
              poc: stat.poc || 0,
              project: stat.project || 0,
              bidding: stat.bidding || 0,
              contracting: stat.contracting || 0,
              signed: stat.signed || 0,
              lost: stat.lost || 0,
              total_count: stat.total_count || 0,
              active_count: stat.active_count || 0,
              completion_rate: stat.completion_rate || 0,
              is_unassigned: !!stat.is_unassigned
            };
          });
          opportunityStatsBySales.value = statsArray.sort((a, b) => {
            // 「未分配」行固定置底，其余按应签商机数降序
            if (a.is_unassigned !== b.is_unassigned) return a.is_unassigned ? 1 : -1;
            return b.total_count - a.total_count;
          });
          
          // 销售下拉数据源：value 用 owner_id，避免同名销售串号
          salesUsers.value = statsArray.map(stat => ({
            id: stat.id,
            name: stat.sales_name
          }));
        }
      } catch (error) {
        console.error('获取商机状态统计失败:', error);
        ElMessage.error('获取商机状态统计失败');
      } finally {
        opportunityStatsLoading.value = false;
      }
    };

    // 周期变化后统一刷新：签约管道 + 商机数据列表，两者跟随同一周期
    const refreshOpportunityPeriod = () => {
      currentPage.value = 1;
      fetchOpportunityStatsBySales();
      fetchFilterableOpportunities();
    };

    const changeQuarter = (offset) => {
      const quarterIndex = selectedQuarter.year * 4 + selectedQuarter.quarter - 1 + offset;
      selectedQuarter.year = Math.floor(quarterIndex / 4);
      selectedQuarter.quarter = quarterIndex % 4 + 1;
      refreshOpportunityPeriod();
    };

    const goToCurrentQuarter = () => {
      selectedQuarter.year = currentQuarter.year;
      selectedQuarter.quarter = currentQuarter.quarter;
      refreshOpportunityPeriod();
    };

    // 按维度切换周期：年度模式按年 ±1，季度模式沿用原季度切换逻辑
    const changeOpportunityPeriod = (offset) => {
      if (opportunityPeriodType.value === 'year') {
        selectedQuarter.year += offset;
        refreshOpportunityPeriod();
      } else {
        // changeQuarter 内部已触发数据刷新
        changeQuarter(offset);
      }
    };

    // 回到当前周期：年度模式回到本年，季度模式沿用原逻辑
    const goToCurrentOpportunityPeriod = () => {
      if (opportunityPeriodType.value === 'year') {
        selectedQuarter.year = currentQuarter.year;
        refreshOpportunityPeriod();
      } else {
        goToCurrentQuarter();
      }
    };

    // 切换统计维度（季度/年度）后重新拉取数据
    const handleOpportunityPeriodTypeChange = () => {
      refreshOpportunityPeriod();
    };

    const formatRate = (value) => `${Number(value || 0).toFixed(1)}%`;

    // 获取按销售统计合同数量和待回款数量
    const fetchContractAndPaymentStatsBySales = async () => {
      contractStatsLoading.value = true;
      try {
        // 统计口径固定为按年
        const response = await getWeeklyMeetingContractsAndPayments({
          period_type: 'year',
          year: contractPeriod.year
        });
        const responseData = response.data?.data || response.data;
        if (responseData && typeof responseData === 'object') {
          const statsArray = Object.keys(responseData).map(key => {
            const stat = responseData[key];
            return {
              sales_name: key,
              id: stat.id,
              contract_count: stat.contract_count || 0,
              pending_payment_count: stat.pending_payment_count || 0
            };
          });
          contractAndPaymentStatsBySales.value = statsArray;
        }
      } catch (error) {
        console.error('获取合同和待回款统计失败:', error);
        ElMessage.error('获取合同和待回款统计失败');
      } finally {
        contractStatsLoading.value = false;
      }
    };

    // 按年切换：左右箭头调整年份
    const changeContractPeriod = (offset) => {
      contractPeriod.year += offset;
      fetchContractAndPaymentStatsBySales();
    };

    const goToCurrentContractPeriod = () => {
      contractPeriod.year = now.getFullYear();
      fetchContractAndPaymentStatsBySales();
    };

    // 构建销售每周进展折线图配置：每位销售一条线，4 个指标各一个数据点
    const buildWeeklyProgressOption = (rows) => ({
      tooltip: {
        trigger: 'axis',
        // hover 提示：标题为指标名，逐行显示每位销售的具体数值
        formatter: (params) => {
          const lines = params.map((item) => `${item.marker}${item.seriesName}：${item.value ?? 0} 个`);
          return `${params[0]?.axisValue ?? ''}<br/>${lines.join('<br/>')}`;
        }
      },
      legend: { type: 'scroll', bottom: 0, left: 'center' },
      grid: { left: '3%', right: '4%', top: 30, bottom: 48, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        // 顺序：新增商机 → 签约商机 → 跟进次数 → 新增合同
        data: ['新增商机', '签约商机', '跟进次数', '新增合同']
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: rows.map((row) => ({
        name: row.sales_name || row.name,
        type: 'line',
        symbolSize: 7,
        data: [
          row.opportunities?.current ?? 0,
          row.signed?.current ?? 0,
          row.followups?.current ?? 0,
          row.contracts?.current ?? 0
        ]
      }))
    });

    // 渲染销售每周进展折线图
    const renderWeeklyProgressChart = () => {
      if (!weeklyProgressChart.value) return;
      const chart = echarts.getInstanceByDom(weeklyProgressChart.value) || echarts.init(weeklyProgressChart.value);
      chart.setOption(buildWeeklyProgressOption(weeklyProgress.value), true);
    };

    const fetchWeeklyProgress = async () => {
      weeklyProgressLoading.value = true;
      try {
        const response = await getWeeklyMeetingWeeklyProgress(buildWeeklyProgressParams());
        weeklyProgress.value = Array.isArray(response.data?.data) ? response.data.data : [];
        weeklyProgressPeriodInfo.value = response.data?.period || {};
        renderWeeklyProgressChart();
      } catch (error) {
        console.error('获取销售周进展失败:', error);
        ElMessage.error('获取销售周进展失败');
      } finally {
        weeklyProgressLoading.value = false;
      }
    };

    // 获取可筛选的商机列表
    const fetchFilterableOpportunities = async () => {
      try {
        // 跟随上方「销售季度签约管道」的统计周期，保证两块数据口径一致
        const params = {
          ...buildPeriodParams(),
          page: currentPage.value,
          limit: 10
        };
        if (filterForm.customer_name.trim()) {
          params.customer_name = filterForm.customer_name.trim();
        }
        if (filterForm.status && filterForm.status.length > 0) {
          params.status = filterForm.status.join(',');
        }
        if (filterForm.owner_id) {
          params.owner_id = filterForm.owner_id;
        }
        
        const response = await getWeeklyMeetingFilterableOpportunities(params);
        const responseData = response.data?.data || response.data;
        if (Array.isArray(responseData)) {
          filterableOpportunities.value = responseData;
          totalOpportunities.value = Number(response.data?.total ?? responseData.length);
        }
      } catch (error) {
        console.error('获取商机列表失败:', error);
        ElMessage.error('获取商机列表失败');
      }
    };

    const applyFilters = () => {
      currentPage.value = 1;
      fetchFilterableOpportunities();
    };

    // 重置筛选条件
    const resetFilters = () => {
      filterForm.customer_name = '';
      filterForm.status = [];
      filterForm.owner_id = '';
      currentPage.value = 1;
      fetchFilterableOpportunities();
    };

    // 状态标签类型映射
    const getStatusTagType = (status) => {
      const typeMap = {
        potential: 'info',
        technical: 'warning',
        poc: 'warning',
        project: 'primary',
        bidding: 'primary',
        contracting: 'success',
        signed: 'success',
        lost: 'danger'
      };
      return typeMap[status] || 'info';
    };

    // 状态文本映射
    const getStatusText = (status) => {
      const textMap = {
        potential: '潜在',
        technical: '技术交流',
        poc: 'POC',
        project: '立项',
        bidding: '招投标',
        contracting: '合同中',
        signed: '已签',
        lost: '已丢失'
      };
      return textMap[status] || status;
    };

    // 商机类型文本映射
    const getOpportunityTypeText = (type) => {
      const textMap = {
        new_project: '新项目',
        renewal: '续签',
        maintenance: '维保',
        other: '其他'
      };
      return textMap[type] || type || '-';
    };

    // 页码变化处理
    const handlePageChange = (page) => {
      currentPage.value = page;
      fetchFilterableOpportunities();
    };

    // 显示跟进记录
    const showFollowups = async (row) => {
      try {
        currentOpportunityName.value = row.opportunity_name;
        followupDialogVisible.value = true;
        const response = await getFollowupsByOpportunity(row.id);
        const data = response.data?.data || response.data;
        followupList.value = Array.isArray(data) ? data : [];
      } catch (error) {
        console.error('获取跟进记录失败:', error);
        ElMessage.error('获取跟进记录失败');
        followupList.value = [];
      }
    };

    // 跟进方式文本映射
    const getTypeText = (type) => {
      const typeMap = {
        phone: '电话',
        meeting: '面谈',
        email: '邮件',
        wechat: '微信',
        other: '其他'
      };
      return typeMap[type] || type || '未知';
    };

    // 格式化时间
    const formatTime = (time) => {
      if (!time) return '';
      return time.replace('T', ' ').substring(0, 19);
    };

    // 窗口缩放时同步刷新折线图尺寸
    const handleWindowResize = () => {
      if (weeklyProgressChart.value) {
        echarts.getInstanceByDom(weeklyProgressChart.value)?.resize();
      }
    };

    // 初始化数据
    onMounted(async () => {
      window.addEventListener('resize', handleWindowResize);
      await fetchOpportunityStatsBySales();
      await fetchWeeklyProgress();
      await fetchContractAndPaymentStatsBySales();
      await fetchFilterableOpportunities();
    });

    // 卸载时移除窗口缩放监听
    onUnmounted(() => {
      window.removeEventListener('resize', handleWindowResize);
    });

    return {
      opportunityStatsBySales,
      opportunityStatsLoading,
      weeklyProgress,
      weeklyProgressLoading,
      weeklyProgressRange,
      weeklyProgressChart,
      weeklyProgressPeriodType,
      weeklyProgressPeriod,
      weeklyProgressPeriodLabel,
      isCurrentWeeklyProgressPeriod,
      changeWeeklyProgressPeriod,
      goToCurrentWeeklyProgressPeriod,
      handleWeeklyProgressPeriodTypeChange,
      contractAndPaymentStatsBySales,
      contractStatsLoading,
      contractPeriod,
      contractPeriodLabel,
      isCurrentContractPeriod,
      filterableOpportunities,
      totalOpportunities,
      currentPage,
      filterForm,
      salesUsers,
      followupDialogVisible,
      currentOpportunityName,
      followupList,
      fetchOpportunityStatsBySales,
      selectedQuarter,
      quarterLabel,
      isCurrentQuarter,
      changeQuarter,
      goToCurrentQuarter,
      opportunityPeriodType,
      opportunitySubtitle,
      opportunityListSubtitle,
      opportunityPeriodLabel,
      isCurrentOpportunityPeriod,
      changeOpportunityPeriod,
      goToCurrentOpportunityPeriod,
      handleOpportunityPeriodTypeChange,
      formatRate,
      ArrowLeft,
      ArrowRight,
      fetchContractAndPaymentStatsBySales,
      changeContractPeriod,
      goToCurrentContractPeriod,
      fetchWeeklyProgress,
      fetchFilterableOpportunities,
      applyFilters,
      resetFilters,
      getStatusTagType,
      getStatusText,
      getOpportunityTypeText,
      handlePageChange,
      showFollowups,
      getTypeText,
      formatTime
    };
  }
};
</script>

<style scoped>
.weekly-meeting {
  padding: 20px;
  background-color: #f8f9fa;
  min-height: 100vh;
}

.section-card {
  margin-bottom: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.card-title {
  font-weight: bold;
  font-size: 16px;
}

.card-subtitle {
  margin-top: 4px;
  color: #8f959e;
  font-size: 12px;
}

.quarter-switcher {
  display: flex;
  align-items: center;
  gap: 8px;
}

.contract-period-toolbar,
.period-switcher {
  display: flex;
  align-items: center;
  gap: 8px;
}

.contract-period-toolbar {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.period-label {
  min-width: 126px;
  text-align: center;
  color: #1f2329;
  font-size: 14px;
  font-weight: 600;
}

.quarter-label {
  min-width: 132px;
  text-align: center;
  color: #1f2329;
  font-size: 14px;
  font-weight: 600;
}

.completion-rate {
  display: grid;
  grid-template-columns: minmax(64px, 1fr) 46px;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.completion-rate strong {
  color: #1f2329;
  font-size: 13px;
  text-align: right;
}

/* 销售每周进展折线图容器 */
.weekly-progress-chart {
  width: 100%;
  height: 360px;
}

@media (max-width: 768px) {
  .weekly-meeting {
    padding: 12px;
  }

  .section-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .contract-period-toolbar {
    align-items: flex-start;
    justify-content: flex-start;
  }

}

.filter-section {
  margin-bottom: 20px;
}

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

.empty-tip {
  text-align: center;
  color: #8f959e;
  padding: 40px 0;
  font-size: 14px;
}

.followup-list {
  max-height: 600px;
  overflow-y: auto;
}

.followup-item {
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  padding: 16px;
  margin-bottom: 12px;
  background-color: #f8f9fa;
}

.followup-item:last-child {
  margin-bottom: 0;
}

.followup-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.followup-user {
  font-weight: 600;
  color: #1f2329;
}

.followup-type {
  color: #646a73;
  font-size: 13px;
}

.followup-time {
  margin-left: auto;
  color: #8f959e;
  font-size: 13px;
}

.followup-content {
  color: #1f2329;
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 8px;
}

.followup-result {
  color: #646a73;
  font-size: 13px;
  margin-bottom: 4px;
}

.followup-next {
  color: #3370ff;
  font-size: 13px;
}

.followup-result .label,
.followup-next .label {
  color: #8f959e;
}
</style>
