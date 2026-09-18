<template>
  <div class="followup-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="客户名称">
            <el-input v-model="filters.customer_name" placeholder="请输入客户名称" clearable />
          </el-form-item>
          <el-form-item label="跟进方式">
            <el-select v-model="filters.type" placeholder="全部" clearable style="width: 120px">
              <el-option label="电话" value="电话" />
              <el-option label="微信" value="微信" />
              <el-option label="邮箱" value="邮箱" />
              <el-option label="拜访" value="拜访" />
              <el-option label="会议" value="会议" />
              <el-option label="其他" value="其他" />
            </el-select>
          </el-form-item>
          <el-form-item label="跟进阶段">
            <el-select v-model="filters.stage" placeholder="全部" clearable multiple style="width: 180px">
              <el-option label="潜在" value="potential" />
              <el-option label="技术交流" value="technical" />
              <el-option label="POC" value="poc" />
              <el-option label="立项" value="project" />
              <el-option label="招投标" value="bidding" />
              <el-option label="合同中" value="contracting" />
              <el-option label="已签" value="signed" />
              <el-option label="已丢失" value="lost" />
            </el-select>
          </el-form-item>
          <el-form-item label="跟进结果">
            <el-select v-model="filters.result" placeholder="全部" clearable style="width: 120px">
              <el-option label="未达成" value="未达成" />
              <el-option label="达成部分" value="达成部分" />
              <el-option label="完全达成" value="完全达成" />
              <el-option label="客户拒绝" value="客户拒绝" />
              <el-option label="客户失联" value="客户失联" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar">
        <el-button v-if="canManageFollowups" type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增跟进
        </el-button>
      </div>

      <el-table
        :data="groupedData"
        v-loading="loading"
        class="followup-table"
        style="width: 100%"
        row-key="groupKey"
        stripe
      >
        <!-- 5 列统一使用相同 min-width，使列宽平均分配 -->
        <el-table-column prop="customer_name" label="客户名称" min-width="140" show-overflow-tooltip />
        <el-table-column prop="opportunity_name" label="商机名称" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.opportunity_name || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="商机状态" min-width="140" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="getStageType(getLatestStage(row))">
              {{ getStageLabel(getLatestStage(row)) }}
            </el-tag>
          </template>
        </el-table-column>
        <!-- 最近跟进（最新 3 条）列：按要求暂时注释隐藏，需要时恢复即可
        <el-table-column label="最近跟进（最新 3 条）" min-width="410" class-name="recent-followup-column">
          <template #default="{ row }">
            <div class="recent-followups">
              <button
                v-for="item in row.previewItems"
                :key="item.id"
                type="button"
                class="recent-followup-item"
                @click="viewDetail(item.id)"
              >
                <span class="followup-time">{{ formatFollowupTime(item) }}</span>
                <el-tag size="small" effect="plain" class="followup-method">{{ item.type || '-' }}</el-tag>
                <span class="followup-content" :title="item.content">{{ item.content }}</span>
                <span class="followup-user">{{ item.user_name || '-' }}</span>
                <el-tag size="small" :type="getStageType(item.stage)" class="followup-stage">
                  {{ getStageLabel(item.stage) }}
                </el-tag>
              </button>
              <button
                v-if="row.items.length > 3"
                type="button"
                class="more-followups"
                @click="openGroupDetail(row)"
              >
                还有 {{ row.items.length - 3 }} 条跟进，查看全部
                <el-icon><ArrowRight /></el-icon>
              </button>
            </div>
          </template>
        </el-table-column>
        -->
        <el-table-column label="跟进次数" min-width="140" align="center">
          <template #default="{ row }">
            <el-button
              class="followup-count-button"
              type="primary"
              link
              @click="openGroupDetail(row)"
            >
              {{ row.items.length }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="140" align="center" fixed="right">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button v-if="canManageFollowups" link type="primary" :icon="Plus" @click="showAddFollowupForGroup(row)">跟进</el-button>
              <el-button link type="primary" :icon="View" @click="openGroupDetail(row)">更多</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增/编辑跟进对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑跟进' : '新增跟进'"
      width="800px"
      :close-on-click-modal="false"
    >
      <el-form :model="followupForm" :rules="rules" ref="formRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户" prop="customer_id">
              <el-select
                v-model="followupForm.customer_id"
                placeholder="请选择客户"
                filterable
                style="width: 100%"
                :disabled="isFromOpportunity"
                @change="onCustomerChange"
              >
                <el-option
                  v-for="customer in customerList"
                  :key="customer.id"
                  :label="customer.name"
                  :value="customer.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联商机" prop="opportunity_id">
              <el-select
                v-model="followupForm.opportunity_id"
                placeholder="请选择商机（必填）"
                filterable
                style="width: 100%"
                :disabled="isFromOpportunity"
              >
                <el-option
                  v-for="opp in opportunityList"
                  :key="opp.id"
                  :label="opp.name"
                  :value="opp.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="跟进方式" prop="type">
              <el-select v-model="followupForm.type" placeholder="请选择跟进方式" style="width: 100%">
                <el-option label="电话" value="电话" />
                <el-option label="微信" value="微信" />
                <el-option label="邮箱" value="邮箱" />
                <el-option label="拜访" value="拜访" />
                <el-option label="会议" value="会议" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="工作类型" prop="work_type">
              <el-select v-model="followupForm.work_type" style="width: 100%">
                <el-option v-for="item in availableWorkTypes" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="跟进内容" prop="content">
              <el-input
                v-model="followupForm.content"
                type="textarea"
                :rows="4"
                placeholder="请详细记录跟进过程（至少 10 个字）"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="跟进阶段">
              <el-select v-model="followupForm.stage" placeholder="请选择阶段" style="width: 100%" :disabled="oppStatusLocked">
                <el-option label="潜在" value="potential" />
                <el-option label="技术交流" value="technical" />
                <el-option label="POC" value="poc" />
                <el-option label="立项" value="project" />
                <el-option label="招投标" value="bidding" />
                <el-option label="合同中" value="contracting" />
                <el-option label="已签" value="signed" />
                <el-option label="已丢失" value="lost" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="跟进结果">
              <el-select v-model="followupForm.result" placeholder="请选择结果" style="width: 100%">
                <el-option label="未达成" value="未达成" />
                <el-option label="达成部分" value="达成部分" />
                <el-option label="完全达成" value="完全达成" />
                <el-option label="客户拒绝" value="客户拒绝" />
                <el-option label="客户失联" value="客户失联" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- 商机全部跟进 -->
    <el-dialog
      v-model="groupDetailVisible"
      title="商机跟进记录"
      width="min(1000px, 94vw)"
      :close-on-click-modal="false"
    >
      <div class="group-detail-header">
        <div>
          <div class="group-detail-title">{{ activeGroup.opportunity_name || '-' }}</div>
          <div class="group-detail-customer">{{ activeGroup.customer_name || '-' }}</div>
        </div>
        <div class="group-detail-summary">
          <span>共 {{ activeGroup.items?.length || 0 }} 条</span>
          <el-tag size="small" :type="getStageType(activeGroup.latest_stage)">
            {{ getStageLabel(activeGroup.latest_stage) }}
          </el-tag>
        </div>
      </div>

      <el-table
        v-loading="groupDetailLoading"
        :data="activeGroup.items || []"
        max-height="500"
        stripe
        class="group-followup-table"
      >
        <el-table-column label="跟进时间" width="170">
          <template #default="{ row }">{{ formatFollowupTime(row) }}</template>
        </el-table-column>
        <el-table-column prop="type" label="方式" width="90" align="center">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.type || '-' }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="stage" label="阶段" width="105" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="getStageType(row.stage)">{{ getStageLabel(row.stage) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="result" label="结果" width="105" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="getResultType(row.result)" effect="light">{{ getResultLabel(row.result) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="跟进内容" min-width="300">
          <template #default="{ row }">
            <!-- 跟进内容完整显示，自动换行，不用省略号截断 -->
            <div class="followup-content-cell">{{ row.content }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="user_name" label="跟进人" width="100" show-overflow-tooltip />
        <el-table-column label="操作" width="120" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="viewDetailFromGroup(row.id)">详情</el-button>
            <!-- 删除按钮：仅 admin / super_admin 可见，与后端删除权限一致 -->
            <el-button v-if="canDeleteFollowup" link type="danger" @click="deleteFollowupFromGroup(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="groupDetailVisible = false">关闭</el-button>
        <el-button v-if="canManageFollowups" type="primary" :icon="Plus" @click="addFollowupFromGroupDetail">新增跟进</el-button>
      </template>
    </el-dialog>

    <!-- 跟进详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="跟进详情"
      width="900px"
      :close-on-click-modal="false"
    >
      <div v-loading="detailLoading">
        <el-descriptions title="基本信息" :column="2" border>
          <el-descriptions-item label="跟进时间">{{ detailData.followup?.followup_time }}</el-descriptions-item>
          <el-descriptions-item label="跟进方式"><el-tag size="small">{{ detailData.followup?.type }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="跟进阶段">
            <el-tag size="small" :type="getStageType(detailData.followup?.stage)">
              {{ getStageLabel(detailData.followup?.stage) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="跟进结果">
            <el-tag size="small" :type="getResultType(detailData.followup?.result)">
              {{ detailData.followup?.result }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="跟进人">{{ detailData.followup?.user_name }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ detailData.followup?.created_at }}</el-descriptions-item>
        </el-descriptions>

        <el-divider>客户信息</el-divider>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="客户名称" :span="2">{{ detailData.followup?.customer_name }}</el-descriptions-item>
          <el-descriptions-item label="客户类型">{{ detailData.followup?.customer_type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="所属行业">{{ detailData.followup?.customer_industry || '-' }}</el-descriptions-item>
          <el-descriptions-item label="客户来源">{{ detailData.followup?.customer_source || '-' }}</el-descriptions-item>
          <el-descriptions-item label="客户等级">{{ detailData.followup?.customer_level || '-' }}</el-descriptions-item>
        </el-descriptions>

        <el-divider>跟进内容</el-divider>
        <el-card shadow="never">
          <div style="white-space: pre-wrap; line-height: 1.8;">{{ detailData.followup?.content }}</div>
        </el-card>

        <el-divider v-if="detailData.followup?.next_followup_at">下次跟进计划</el-divider>
        <el-alert v-if="detailData.followup?.next_followup_at" type="info" :closable="false" show-icon>
          <div><strong>跟进时间：</strong>{{ detailData.followup.next_followup_at }}</div>
          <div v-if="detailData.followup?.next_followup_content"><strong>跟进内容：</strong>{{ detailData.followup.next_followup_content }}</div>
        </el-alert>

        <el-divider>客户历史跟进（共 {{ detailData.followup?.customer_followups?.length || 0 }} 条）</el-divider>
        <el-table :data="detailData.followup?.customer_followups || []" size="small" max-height="300">
          <el-table-column label="序号" width="60" align="center">
            <template #default="{ $index }">
              <el-tag size="small" type="primary">{{ $index + 1 }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="followup_time_formatted" label="时间" width="180" />
          <el-table-column prop="type" label="方式" width="80">
            <template #default="{ row }">
              <el-tag size="small">{{ row.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="200" show-overflow-tooltip />
          <el-table-column prop="user_name" label="跟进人" width="100" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="canManageFollowups" type="primary" @click="editFromDetail">编辑</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, View, ArrowRight } from '@element-plus/icons-vue'
import request from '@/utils/request'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const groupDetailVisible = ref(false)
const groupDetailLoading = ref(false)
const detailLoading = ref(false)
const isEdit = ref(false)
const formRef = ref(null)
const detailData = ref({})
const activeGroup = ref({ items: [] })
const currentFollowupId = ref('')
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const route = useRoute()
const canManageFollowups = !['operations', 'fde_admin'].includes(currentUser.role)
const workTypeMap = {
  sales: [{ label: '销售跟进', value: 'sales' }],
  operations: [{ label: '宣传推广', value: 'promotion' }],
  presales: [{ label: '技术沟通', value: 'technical' }, { label: '交付支持', value: 'delivery' }],
  fde: [{ label: '技术沟通', value: 'technical' }, { label: '交付支持', value: 'delivery' }]
}
const availableWorkTypes = computed(() => workTypeMap[currentUser.role] || [
  { label: '销售跟进', value: 'sales' },
  { label: '宣传推广', value: 'promotion' },
  { label: '技术沟通', value: 'technical' },
  { label: '交付支持', value: 'delivery' }
])
const defaultWorkType = () => availableWorkTypes.value[0]?.value || 'sales'

const filters = reactive({ customer_name: '', type: '', stage: [], result: '' })
const tableData = ref([])
const customerList = ref([])
const opportunityList = ref([])
const pagination = reactive({ page: 1, limit: 10, total: 0 })

const followupForm = reactive({
  id: '', customer_id: '', opportunity_id: '', type: '', work_type: defaultWorkType(), content: '', stage: '', result: ''
})
const oppStatusLocked = ref(false)

// 按客户+商机分组
const groupedData = computed(() => {
  const map = new Map()
  for (const item of tableData.value) {
    const key = `${item.customer_id}_${item.opportunity_id || ''}`
    if (!map.has(key)) {
      map.set(key, {
        groupKey: key,
        customer_name: item.customer_name,
        opportunity_name: item.opportunity_name || '-',
        customer_id: item.customer_id,
        opportunity_id: item.opportunity_id || null,
        latest_time: item.followup_time || item.created_at,
        latest_user_name: item.user_name,
        latest_stage: item.stage || '',
        items: []
      })
    }
    const group = map.get(key)
    group.items.push(item)
    const itemTime = item.followup_time || item.created_at
    if (itemTime > group.latest_time) {
      group.latest_time = itemTime
      group.latest_user_name = item.user_name
      group.latest_stage = item.stage || ''
    }
  }
  return Array.from(map.values())
    .map(group => {
      group.items.sort((a, b) => getFollowupTimestamp(b) - getFollowupTimestamp(a))
      group.previewItems = group.items.slice(0, 3)
      const latest = group.previewItems[0]
      group.latest_time = latest?.followup_time || latest?.created_at || ''
      group.latest_user_name = latest?.user_name || ''
      group.latest_stage = latest?.stage || ''
      return group
    })
    .sort((a, b) => getFollowupTimestamp(b.previewItems[0]) - getFollowupTimestamp(a.previewItems[0]))
})

// 获取分组的最新商机状态
const getLatestStage = (row) => {
  return row.latest_stage || '-'
}

function getFollowupTimestamp(item) {
  if (!item) return 0
  const value = item.followup_time || item.created_at || ''
  const timestamp = new Date(value.replace?.(' ', 'T') || value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

const formatFollowupTime = (item) => {
  const value = item?.followup_time || item?.created_at
  if (!value) return '-'
  const match = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/)
  if (!match) return String(value).replace('T', ' ').slice(0, 16)
  const [, year, month, day, hour, minute] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

const getResultLabel = (result) => result === 'pending' ? '未出结果' : (result || '-')

const openGroupDetail = async (group) => {
  activeGroup.value = { ...group, items: [...group.items] }
  groupDetailVisible.value = true

  if (!group.opportunity_id) return

  groupDetailLoading.value = true
  try {
    const { data } = await request.get(`/api/followups/by-opportunity/${group.opportunity_id}`)
    const items = (data.data || [])
      .map(item => ({ ...item, user_name: item.user_name || item.followup_user_name }))
      .sort((a, b) => getFollowupTimestamp(b) - getFollowupTimestamp(a))
    activeGroup.value = {
      ...group,
      items,
      latest_stage: items[0]?.stage || group.latest_stage
    }
  } catch (error) {
    ElMessage.error('加载全部跟进失败：' + (error.response?.data?.error || '未知错误'))
  } finally {
    groupDetailLoading.value = false
  }
}

const viewDetailFromGroup = (id) => {
  groupDetailVisible.value = false
  viewDetail(id)
}

const addFollowupFromGroupDetail = () => {
  const group = activeGroup.value
  groupDetailVisible.value = false
  showAddFollowupForGroup(group)
}

// 判断当前用户是否可删除跟进记录（与后端权限一致：仅 admin / super_admin 可删除）
const canDeleteFollowup = ['admin', 'super_admin'].includes(currentUser.role)

// 在商机跟进记录对话框中删除跟进记录
const deleteFollowupFromGroup = async (row) => {
  try {
    await ElMessageBox.confirm('确定删除该跟进记录吗？删除后不可恢复。', '删除跟进记录', { type: 'warning' })
    await request.delete(`/api/followups/${row.id}`)
    ElMessage.success('跟进记录已删除')
    // 刷新主列表分组与对话框列表（复用现有加载逻辑）
    await loadData()
    await openGroupDetail(activeGroup.value)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '删除跟进记录失败')
    }
  }
}

// 标识是否从商机页面跳转过来
const isFromOpportunity = ref(false)

const rules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  opportunity_id: [{ required: true, message: '请选择关联商机', trigger: 'change' }],
  type: [{ required: true, message: '请选择跟进方式', trigger: 'change' }],
  content: [
    { required: true, message: '请输入跟进内容', trigger: 'blur' },
    { min: 10, message: '跟进内容至少 10 个字', trigger: 'blur' }
  ]
}

const getStageType = (stage) => {
  const map = { potential: 'primary', technical: 'info', poc: 'warning', project: 'primary', bidding: 'primary', contracting: 'success', signed: 'success', lost: 'danger' }
  return map[stage]
}

const getStageLabel = (stage) => {
  const map = { potential: '潜在', technical: '技术交流', poc: 'POC', project: '立项', bidding: '招投标', contracting: '合同中', signed: '已签', lost: '已丢失' }
  return map[stage] || stage
}

const getResultType = (result) => {
  const map = { '未达成': 'info', '达成部分': 'warning', '完全达成': 'success', '客户拒绝': 'danger', '客户失联': 'danger' }
  return map[result]
}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/followups', { params: {
      page: pagination.page,
      limit: pagination.limit,
      customer_name: filters.customer_name || undefined,
      type: filters.type || undefined,
      stage: filters.stage && filters.stage.length > 0 ? filters.stage.join(',') : undefined,
      result: filters.result || undefined
    } })
    tableData.value = data.data
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载跟进列表失败')
  } finally {
    loading.value = false
  }
}

const loadCustomers = async () => {
  try {
    const { data } = await request.get('/api/customers', { params: { limit: 100 } })
    customerList.value = data.data || []
  } catch (error) {
    customerList.value = []
  }
}

// 标记是否已经由 showAddFollowupForGroup 预先处理过状态
let _oppStatusHandled = false

// 监听商机选择变化，自动设置跟进阶段并锁定
watch(
  () => followupForm.opportunity_id,
  async (newOppId) => {
    if (!newOppId || isEdit.value || _oppStatusHandled) return
    // 加载该客户下的商机列表以获取状态
    try {
      const oppRes = await request.get('/api/opportunities', { params: { customer_id: followupForm.customer_id || null, limit: 200 } })
      const opps = oppRes.data.data || []
      const opp = opps.find(o => o.id === newOppId)
      if (opp?.status === 'signed') {
        // 已签商机可以添加跟进，但建议保持已签状态
        followupForm.stage = 'signed'
        // 不锁定，允许用户根据实际情况调整
        oppStatusLocked.value = false
      } else {
        oppStatusLocked.value = false
      }
    } catch {
      oppStatusLocked.value = false
    }
  }
)

const showAddDialog = () => {
  isEdit.value = false
  oppStatusLocked.value = false
  _oppStatusHandled = false
  Object.assign(followupForm, { id: '', customer_id: '', opportunity_id: '', type: '', work_type: defaultWorkType(), content: '', stage: '', result: '' })
  loadCustomers()
  dialogVisible.value = true
}

// 为指定分组新增跟进
const showAddFollowupForGroup = async (group) => {
  isEdit.value = false
  _oppStatusHandled = true
  await loadCustomers()
  // 加载商机列表
  try {
    const oppRes = await request.get('/api/opportunities', { params: { limit: 200 } })
    opportunityList.value = oppRes.data.data || []
  } catch {
    opportunityList.value = []
  }
  
  // 检查商机状态
  const opp = opportunityList.value.find(o => o.id === group.opportunity_id)
  if (opp?.status === 'signed') {
    // 已签商机可以添加跟进，但建议保持已签状态
    followupForm.stage = 'signed'
    // 不锁定，允许用户根据实际情况调整
    oppStatusLocked.value = false
  } else {
    oppStatusLocked.value = false
  }
  
  Object.assign(followupForm, {
    id: '',
    customer_id: group.customer_id,
    opportunity_id: group.opportunity_id || '',
    type: '',
    work_type: defaultWorkType(),
    content: '',
    stage: opp?.status === 'signed' ? 'signed' : '',
    result: ''
  })
  dialogVisible.value = true
}

const editFollowup = async (row) => {
  isEdit.value = true
  Object.assign(followupForm, {
    id: row.id,
    customer_id: row.customer_id,
    opportunity_id: row.opportunity_id || '',
    type: row.type,
    work_type: row.work_type || defaultWorkType(),
    content: row.content,
    stage: row.stage,
    result: row.result
  })
  await Promise.all([loadCustomers(), loadOpportunities(row.customer_id)])
  dialogVisible.value = true
}

const editFromDetail = () => {
  if (!detailData.value.followup) return
  detailVisible.value = false
  editFollowup(detailData.value.followup)
}

const submitForm = async () => {
  if (!formRef.value) return
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    submitting.value = true
    try {
      if (isEdit.value) {
        await request.put(`/api/followups/${followupForm.id}`, followupForm)
        ElMessage.success('更新成功')
      } else {
        await request.post('/api/followups', followupForm)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
      loadData()
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '操作失败')
    } finally {
      submitting.value = false
    }
  })
}

const viewDetail = async (id) => {
  currentFollowupId.value = id
  detailLoading.value = true
  try {
    const { data } = await request.get(`/api/followups/${id}`)
    detailData.value = data
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载详情失败：' + (error.response?.data?.error || '未知错误'))
  } finally {
    detailLoading.value = false
  }
}

const resetFilters = () => {
  Object.assign(filters, { customer_name: '', type: '', stage: [], result: '' })
  loadData()
}

// 客户改变时加载商机
const onCustomerChange = (customerId) => {
  if (customerId) {
    loadOpportunities(customerId)
    followupForm.opportunity_id = ''
  } else {
    opportunityList.value = []
  }
}

// 加载客户下的商机列表
const loadOpportunities = async (customerId) => {
  try {
    const { data } = await request.get('/api/opportunities', {
      params: { customer_id: customerId, limit: 100 }
    })
    // 后端已按负责销售或技术指派范围过滤，不能再按创建人过滤。
    opportunityList.value = data.data || []
  } catch (error) {
    opportunityList.value = []
  }
}

onMounted(() => {
  loadData()
  loadCustomers()
  
  // 检查 URL 参数，如果是从商机页面跳转过来的，自动打开新增对话框
  if (route.query.action === 'create' && route.query.customer_id) {
    isFromOpportunity.value = true
    showAddDialog()
    // 设置客户信息
    followupForm.customer_id = route.query.customer_id
    // 设置商机信息
    if (route.query.opportunity_id) {
      followupForm.opportunity_id = route.query.opportunity_id
    }
    // 加载该客户的商机列表
    loadOpportunities(route.query.customer_id)
  }
})
</script>

<style scoped>
.followup-list {
  padding: 0;
}

.filter-bar {
  margin-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border-light);
  padding-bottom: var(--spacing-lg);
}

.filter-bar .el-form-item {
  margin-bottom: var(--spacing-sm);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}

.followup-table :deep(.el-table__cell) {
  vertical-align: middle;
}

.followup-count-button {
  font-weight: 600;
}

.recent-followups {
  display: grid;
  padding: 4px 0;
}

.recent-followup-item {
  display: grid;
  grid-template-columns: 120px 48px minmax(78px, 1fr) 60px 66px;
  gap: 6px;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 5px 6px;
  border: 0;
  border-bottom: 1px solid #f0f1f3;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.recent-followup-item:hover {
  background: #e1e9ff;
}

.recent-followup-item:last-of-type {
  border-bottom: 0;
}

.followup-time,
.followup-user,
.followup-content {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.followup-time {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.followup-content {
  color: var(--color-text-primary);
}

.followup-user {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.followup-method,
.followup-stage {
  justify-self: start;
  max-width: 100%;
}

.more-followups {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 3px;
  min-height: 28px;
  margin-top: 2px;
  padding: 2px 6px;
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.more-followups:hover {
  color: var(--el-color-primary-light-3);
}

.table-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  white-space: nowrap;
}

.table-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.group-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: -4px 0 16px;
  padding: 12px 14px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  background: #f2f3f5;
}

.group-detail-title {
  color: var(--color-text-primary);
  font-size: 16px;
  font-weight: 600;
}

.group-detail-customer {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.group-detail-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.group-followup-table :deep(.el-table__cell) {
  padding: 8px 0;
}

/* 跟进内容单元格：完整显示并自动换行 */
.followup-content-cell {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .group-detail-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
}
</style>
