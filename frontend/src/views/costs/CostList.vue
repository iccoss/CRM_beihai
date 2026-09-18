<template>
  <div class="cost-list">
    <el-card>
      <div class="header-bar">
        <span style="font-weight:bold;font-size:16px">成本管理</span>
        <div>
          <el-select v-model="batchMonth" style="width:130px;margin-right:8px">
            <el-option :label="'2026年1月'" value="2026-01"/>
            <el-option :label="'2026年2月'" value="2026-02"/>
            <el-option :label="'2026年3月'" value="2026-03"/>
            <el-option :label="'2026年4月'" value="2026-04"/>
            <el-option :label="'2026年5月'" value="2026-05"/>
            <el-option :label="'2026年6月'" value="2026-06"/>
            <el-option :label="'2026年7月'" value="2026-07"/>
            <el-option :label="'2026年8月'" value="2026-08"/>
            <el-option :label="'2026年9月'" value="2026-09"/>
            <el-option :label="'2026年10月'" value="2026-10"/>
            <el-option :label="'2026年11月'" value="2026-11"/>
            <el-option :label="'2026年12月'" value="2026-12"/>
          </el-select>
          <el-button type="primary" @click="saveBatch" :disabled="isOperations" title="运营角色只读，无权操作">保存全部</el-button>
        </div>
      </div>

      <!-- 7行批量录入 -->
      <div style="margin-bottom:16px">
        <div style="font-size:13px;color:#8f959e;margin-bottom:8px">批量录入（有就填，没有留空）</div>
        <el-table :data="batchRows" border size="small">
          <el-table-column label="大类" width="80">
            <template #default="{ row }">{{ row.categoryLabel }}</template>
          </el-table-column>
          <el-table-column label="子类" width="80">
            <template #default="{ row }">{{ row.subLabel }}</template>
          </el-table-column>
          <el-table-column label="金额(元)" width="140">
            <template #default="{ row }">
              <el-input-number v-model="row.amount" :min="0" :precision="2" :step="100" size="small" style="width:100%" placeholder="0.00"/>
            </template>
          </el-table-column>
          <el-table-column label="备注">
            <template #default="{ row }">
              <el-input v-model="row.description" size="small" placeholder="选填"/>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 管理员：各销售成本汇总 -->
      <div v-if="isAdminView()">
        <h3 style="margin:16px 0 8px">各销售成本汇总（{{ batchMonth.slice(0,4) }}年）</h3>
        <el-table :data="getAdminSummaryRows()" border size="small" show-summary :summary-method="getAdminSummary">
          <el-table-column prop="user_name" label="姓名" min-width="100" fixed />
          <el-table-column label="打车" min-width="80" align="right"><template #default="{ row }">{{ row.taxi ? fmt(row.taxi) : '-' }}</template></el-table-column>
          <el-table-column label="餐费" min-width="80" align="right"><template #default="{ row }">{{ row.meal ? fmt(row.meal) : '-' }}</template></el-table-column>
          <el-table-column label="机票" min-width="80" align="right"><template #default="{ row }">{{ row.flight ? fmt(row.flight) : '-' }}</template></el-table-column>
          <el-table-column label="火车" min-width="80" align="right"><template #default="{ row }">{{ row.train ? fmt(row.train) : '-' }}</template></el-table-column>
          <el-table-column label="酒店" min-width="80" align="right"><template #default="{ row }">{{ row.hotel ? fmt(row.hotel) : '-' }}</template></el-table-column>
          <el-table-column label="差旅小计" min-width="90" align="right"><template #default="{ row }" style="color:#3370ff;font-weight:bold">{{ row.travel ? fmt(row.travel) : '-' }}</template></el-table-column>
          <el-table-column label="招待费" min-width="80" align="right"><template #default="{ row }">{{ row.entertainment ? fmt(row.entertainment) : '-' }}</template></el-table-column>
          <el-table-column label="其他费用" min-width="90" align="right"><template #default="{ row }">{{ row.other ? fmt(row.other) : '-' }}</template></el-table-column>
          <el-table-column label="个人合计" min-width="100" align="right"><template #default="{ row }" style="font-weight:bold">{{ row.total ? fmt(row.total) : '-' }}</template></el-table-column>
        </el-table>
      </div>

      <!-- 月度汇总表 -->
      <h3 style="margin:16px 0 8px">月度费用汇总（元）</h3>
      <el-table :data="summaryTableRows" border size="small" show-summary :summary-method="getSummary">
        <el-table-column prop="month" label="月份" min-width="90" align="center" fixed/>
        <el-table-column label="打车" min-width="80" align="right"><template #default="{ row }">{{ row.taxi ? fmt(row.taxi) : '-' }}</template></el-table-column>
        <el-table-column label="餐费" min-width="80" align="right"><template #default="{ row }">{{ row.meal ? fmt(row.meal) : '-' }}</template></el-table-column>
        <el-table-column label="机票" min-width="80" align="right"><template #default="{ row }">{{ row.flight ? fmt(row.flight) : '-' }}</template></el-table-column>
        <el-table-column label="火车" min-width="80" align="right"><template #default="{ row }">{{ row.train ? fmt(row.train) : '-' }}</template></el-table-column>
        <el-table-column label="酒店" min-width="80" align="right"><template #default="{ row }">{{ row.hotel ? fmt(row.hotel) : '-' }}</template></el-table-column>
        <el-table-column label="差旅小计" min-width="90" align="right"><template #default="{ row }" style="color:#3370ff;font-weight:bold">{{ row.travel ? fmt(row.travel) : '-' }}</template></el-table-column>
        <el-table-column label="招待费" min-width="90" align="right"><template #default="{ row }">{{ row.entertainment ? fmt(row.entertainment) : '-' }}</template></el-table-column>
        <el-table-column label="其他费用" min-width="90" align="right"><template #default="{ row }">{{ row.other ? fmt(row.other) : '-' }}</template></el-table-column>
        <el-table-column label="月度合计" min-width="100" align="right"><template #default="{ row }" style="font-weight:bold">{{ row.total ? fmt(row.total) : '-' }}</template></el-table-column>
      </el-table>

      <el-empty v-if="!loading && summaryTableRows.length === 0" description="暂无费用记录" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

// 运营角色只读：录入框与保存按钮置灰禁用
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const isOperations = currentUser.role === 'operations'

const loading = ref(false)
const tableData = ref([])
const summary = ref({ month_total: 0 })
const summaryTableRows = ref([])
const adminUserData = ref([])
const batchMonth = ref(new Date().toISOString().slice(0, 7))

const travelSubs = [
  { key: 'taxi', label: '打车' },
  { key: 'meal', label: '餐费' },
  { key: 'flight', label: '机票' },
  { key: 'train', label: '火车' },
  { key: 'hotel', label: '酒店' }
]

const initBatchRows = () => [
  { category: 'travel', sub_category: 'taxi', categoryLabel: '差旅成本', subLabel: '打车', amount: null, description: '' },
  { category: 'travel', sub_category: 'meal', categoryLabel: '差旅成本', subLabel: '餐费', amount: null, description: '' },
  { category: 'travel', sub_category: 'flight', categoryLabel: '差旅成本', subLabel: '机票', amount: null, description: '' },
  { category: 'travel', sub_category: 'train', categoryLabel: '差旅成本', subLabel: '火车', amount: null, description: '' },
  { category: 'travel', sub_category: 'hotel', categoryLabel: '差旅成本', subLabel: '酒店', amount: null, description: '' },
  { category: 'entertainment', sub_category: null, categoryLabel: '招待费', subLabel: '—', amount: null, description: '' },
  { category: 'other', sub_category: null, categoryLabel: '其他费用', subLabel: '—', amount: null, description: '' }
]

const batchRows = ref(initBatchRows())

const fmt = (v) => {
  const n = Number(v) || 0
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const onCategoryChange = (row) => {}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/costs', { params: { month: batchMonth.value } })
    tableData.value = data.data || []
    summary.value = data.summary || { month_total: 0 }

    // 加载月度汇总表（全年数据）
    const year = batchMonth.value.slice(0, 4)
    const { data: yearData } = await request.get('/api/costs/monthly-summary', { params: { year } })
    summaryTableRows.value = yearData.data || []
    adminUserData.value = yearData.is_admin ? yearData.data : []
  } catch (e) {
    ElMessage.error('加载数据失败')
  } finally {
    loading.value = false
  }
}

const isAdminView = () => adminUserData.value.length > 0

const getAdminSummaryRows = () => {
  // 汇总每个销售全年的数据
  const userTotals = {}
  adminUserData.value.forEach(u => {
    const totals = { user_id: u.user_id, user_name: u.user_name, taxi: 0, meal: 0, flight: 0, train: 0, hotel: 0, travel: 0, entertainment: 0, other: 0, total: 0 }
    Object.values(u.months).forEach(m => {
      totals.taxi += m.taxi || 0; totals.meal += m.meal || 0; totals.flight += m.flight || 0
      totals.train += m.train || 0; totals.hotel += m.hotel || 0
      totals.entertainment += m.entertainment || 0; totals.other += m.other || 0
      totals.total += m.total || 0
    })
    totals.travel = parseFloat((totals.taxi + totals.meal + totals.flight + totals.train + totals.hotel).toFixed(2))
    totals.taxi = parseFloat(totals.taxi.toFixed(2)); totals.meal = parseFloat(totals.meal.toFixed(2))
    totals.flight = parseFloat(totals.flight.toFixed(2)); totals.train = parseFloat(totals.train.toFixed(2))
    totals.hotel = parseFloat(totals.hotel.toFixed(2)); totals.entertainment = parseFloat(totals.entertainment.toFixed(2))
    totals.other = parseFloat(totals.other.toFixed(2)); totals.total = parseFloat(totals.total.toFixed(2))
    userTotals[u.user_id] = totals
  })
  return Object.values(userTotals)
}

const getAdminSummary = ({ columns, data }) => {
  const sums = []
  const props = ['user_name','taxi','meal','flight','train','hotel','travel','entertainment','other','total']
  columns.forEach((col, idx) => {
    const prop = props[idx]
    if (idx === 0) { sums[idx] = '合计'; return }
    let total = 0
    data.forEach(row => { total += (row[prop] || 0) })
    sums[idx] = total > 0 ? '¥' + fmt(total) : '-'
  })
  return sums
}

const getSummary = ({ columns, data }) => {
  const sums = []
  const props = ['month','taxi','meal','flight','train','hotel','travel','entertainment','other','total']
  columns.forEach((col, idx) => {
    if (idx === 0) { sums[idx] = '合计'; return }
    const prop = props[idx]
    if (!prop) { sums[idx] = ''; return }
    let total = 0
    data.forEach(row => { total += (row[prop] || 0) })
    sums[idx] = total > 0 ? '¥' + fmt(total) : '-'
  })
  return sums
}

const saveBatch = async () => {
  const filled = batchRows.value.filter(r => r.amount && r.amount > 0)
  if (filled.length === 0) return ElMessage.warning('请至少填写一项费用')

  let success = 0
  let fail = 0
  for (const row of filled) {
    try {
      const payload = {
        month: batchMonth.value,
        category: row.category,
        sub_category: row.sub_category,
        amount: row.amount,
        description: row.description || null
      }
      await request.post('/api/costs', payload)
      success++
    } catch (e) {
      fail++
      console.error('保存失败:', e)
    }
  }

  if (fail === 0) {
    ElMessage.success(`成功保存 ${success} 条记录`)
  } else {
    ElMessage.warning(`成功 ${success} 条，失败 ${fail} 条`)
  }

  // 清空已填写的行
  batchRows.value.forEach(r => {
    r.amount = null
    r.description = ''
  })

  loadData()
}

const del = async (row) => {
  try {
    await ElMessageBox.confirm(`确定删除该费用记录？`, '提示', { type: 'warning' })
    await request.delete(`/api/costs/${row.id}`)
    ElMessage.success('删除成功')
    loadData()
  } catch (e) {}
}

onMounted(loadData)
</script>

<style scoped>
.cost-list {
  padding: 0;
}

.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-lg);
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.summary-card .summary-value {
  font-size: 24px;
  font-weight: bold;
}

.summary-card {
  min-height: 130px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
</style>
