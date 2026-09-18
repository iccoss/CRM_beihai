<template>
  <div class="contract-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="客户名称">
            <el-input v-model="filters.customer_name" placeholder="请输入客户名称" clearable />
          </el-form-item>
          <el-form-item label="合同状态">
            <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px">
              <el-option label="执行中" value="active" />
              <el-option label="已完成" value="completed" />
              <el-option label="已终止" value="terminated" />
            </el-select>
          </el-form-item>
          <el-form-item label="合同类型">
            <el-select v-model="filters.opportunity_type" placeholder="全部" clearable style="width: 120px">
              <el-option label="新项目" value="new_project" />
              <el-option label="续签" value="renewal" />
              <el-option label="维护" value="maintenance" />
            </el-select>
          </el-form-item>
          <el-form-item label="签订日期">
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
              style="width: 240px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增合同
        </el-button>
        <el-button type="warning" @click="showExpiringContracts">
          <el-icon><Clock /></el-icon>
          到期提醒
          <el-badge :value="expiringCount" :hidden="expiringCount === 0" type="danger" />
        </el-button>
      </div>

      <el-table :data="tableData" v-loading="loading">
        <el-table-column prop="customer_name" label="客户" width="140" show-overflow-tooltip />
        <el-table-column prop="title" label="合同名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="contract_type_label" label="合同类型" width="100" />
        <el-table-column prop="sign_date" label="签订日期" width="110" />
        <el-table-column label="合同金额(元)" width="180" align="right">
          <template #default="{ row }">
            <span style="white-space: nowrap">{{ formatLargeNumber(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="渠道佣金(元)" width="120" align="right">
          <template #default="{ row }">
            <span style="white-space: nowrap; color: #8f959e">{{ row.channel_commission ? formatLargeNumber(row.channel_commission) : '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="回款金额(元)" width="180" align="right">
          <template #default="{ row }">
            <span style="white-space: nowrap; color: #34c724; font-weight: bold">{{ formatLargeNumber(row.total_received || 0) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click">
              <el-button text type="primary" size="small">操作 ▾</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="viewDetail(row.id)">详情</el-dropdown-item>
                  <el-dropdown-item @click="editContract(row)">编辑</el-dropdown-item>
                  <el-dropdown-item v-if="isAdmin" style="color: #f54a45" @click="deleteContract(row)">删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.limit"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- 新增/编辑合同对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑合同' : '新增合同'"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-form :model="contractForm" :rules="rules" ref="formRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户" prop="customer_id">
              <el-select
                v-model="contractForm.customer_id"
                placeholder="请选择客户"
                filterable
                style="width: 100%"
                @change="handleCustomerChange"
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
                v-model="contractForm.opportunity_id"
                placeholder="请选择关联商机(必填)"
                filterable
                style="width: 100%"
                :disabled="!contractForm.customer_id"
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
            <el-form-item label="联系人">
              <el-select
                v-model="contractForm.contact_id"
                placeholder="请选择联系人"
                filterable
                clearable
                style="width: 100%"
                :disabled="!contractForm.customer_id"
              >
                <el-option
                  v-for="contact in contactList"
                  :key="contact.id"
                  :label="contact.name + (contact.position ? ' (' + contact.position + ')' : '')"
                  :value="contact.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="合同名称" prop="title">
              <el-input v-model="contractForm.title" placeholder="请输入合同名称" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="付款方式" prop="payment_method">
              <el-select v-model="contractForm.payment_method" placeholder="请选择付款方式" style="width: 100%">
                <el-option label="按月" value="monthly" />
                <el-option label="按季度" value="quarterly" />
                <el-option label="按年" value="yearly" />
                <el-option label="按次" value="per_time" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="付款次数" prop="payment_times">
              <el-input-number
                v-model="contractForm.payment_times"
                :min="1"
                :max="4"
                :disabled="contractForm.payment_method !== 'per_time'"
                style="width: 100%"
                placeholder="按次付款时填写次数(最多 4 次)"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="付款条款">
              <el-input
                v-model="contractForm.payment_terms"
                type="textarea"
                :rows="3"
                placeholder="请输入付款条款,例如:首付款 30%,验收后 70%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="合同内容">
              <el-input
                v-model="contractForm.content"
                type="textarea"
                :rows="5"
                placeholder="请输入合同详细内容"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同类型" prop="type">
              <el-select v-model="contractForm.type" placeholder="请选择合同类型" style="width: 100%">
                <el-option label="销售合同" value="销售合同" />
                <el-option label="采购合同" value="采购合同" />
                <el-option label="服务合同" value="服务合同" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="合同状态">
              <el-select v-model="contractForm.status" placeholder="请选择状态" style="width: 100%">
                <el-option label="执行中" value="active" />
                <el-option label="已完成" value="completed" />
                <el-option label="已终止" value="terminated" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同金额" prop="amount">
              <el-input-number
                v-model="contractForm.amount"
                :min="0"
                :precision="2"
                :step="1000"
                style="width: 100%"
                placeholder="请输入合同金额"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="签订日期" prop="sign_date">
              <el-date-picker
                v-model="contractForm.sign_date"
                type="date"
                placeholder="选择签订日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="生效日期" prop="effective_date">
              <el-date-picker
                v-model="contractForm.effective_date"
                type="date"
                placeholder="选择生效日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="到期日期" prop="expire_date">
              <el-date-picker
                v-model="contractForm.expire_date"
                type="date"
                placeholder="选择到期日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="合同条款">
              <el-input
                v-model="contractForm.payment_terms"
                type="textarea"
                :rows="3"
                placeholder="请输入付款条款"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="合同内容">
              <el-input
                v-model="contractForm.content"
                type="textarea"
                :rows="5"
                placeholder="请输入合同详细内容"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 付款计划 -->
        <el-divider>付款计划</el-divider>
        <el-alert
          title="付款计划为必填项，根据付款方式自动生成付款计划"
          type="warning"
          :closable="false"
          style="margin-bottom: 15px"
        />
        <div v-if="contractForm.payment_method" style="margin-bottom: 15px">
          <el-button type="primary" size="small" @click="generatePaymentPlans">
            生成付款计划
          </el-button>
        </div>
        <div v-if="contractForm.payment_plans && contractForm.payment_plans.length > 0">
          <div v-for="(plan, index) in contractForm.payment_plans" :key="index" style="margin-bottom: 15px; padding: 15px; border: 1px solid #dee0e3; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-weight: bold; color: #3370ff;">第{{ index + 1 }}期付款</span>
              <el-button type="danger" size="small" @click="removePaymentPlan(index)">删除</el-button>
            </div>
            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="付款金额" :rules="[{ required: true, message: '请输入金额', trigger: 'blur' }]">
                  <el-input-number
                    v-model="plan.amount"
                    :min="0"
                    :precision="2"
                    style="width: 100%"
                    placeholder="请输入付款金额"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="付款日期" :rules="[{ required: true, message: '请选择日期', trigger: 'change' }]">
                  <el-date-picker
                    v-model="plan.date"
                    type="date"
                    placeholder="选择付款日期"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
            </el-row>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- 合同详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="合同详情"
      width="900px"
    >
      <div v-loading="detailLoading">
        <el-tabs>
          <el-tab-pane label="基本信息">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="合同编号">{{ detailData.contract?.contract_no }}</el-descriptions-item>
          <el-descriptions-item label="合同名称" :span="3">{{ detailData.contract?.title }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ detailData.contract?.customer_name }}</el-descriptions-item>
          <el-descriptions-item label="联系人">{{ detailData.contract?.contact_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="合同类型">{{ detailData.contract?.type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="合同状态">
            <el-tag :type="getStatusType(detailData.contract?.status)" size="small">
              {{ getStatusLabel(detailData.contract?.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="合同金额(元)">
            <span style="color: #f54a45; font-weight: bold; font-size: 16px; white-space: nowrap;">
              {{ formatLargeNumber(detailData.contract?.amount) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="已回款金额(元)">
            <span style="color: #34c724; font-weight: bold; white-space: nowrap;">
              {{ formatLargeNumber(detailData.contract?.total_received) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="未回款金额(元)">
            <span style="color: #f54a45; font-weight: bold; white-space: nowrap;">
              {{ formatLargeNumber(detailData.contract?.unpaid_amount) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="回款进度" :span="3">
            <el-progress
              :percentage="parseFloat(detailData.contract?.payment_progress || 0)"
              :status="parseFloat(detailData.contract?.payment_progress || 0) >= 100 ? 'success' : undefined"
            />
          </el-descriptions-item>
          <el-descriptions-item label="签订日期">{{ detailData.contract?.sign_date || '-' }}</el-descriptions-item>
          <el-descriptions-item label="生效日期">{{ detailData.contract?.effective_date || '-' }}</el-descriptions-item>
          <el-descriptions-item label="到期日期">{{ detailData.contract?.expire_date || '-' }}</el-descriptions-item>
          <el-descriptions-item label="付款方式">
            {{ getPaymentMethodLabel(detailData.contract?.payment_method) }}
          </el-descriptions-item>
          <el-descriptions-item label="付款次数" v-if="detailData.contract?.payment_method === 'per_time'">
            {{ detailData.contract?.payment_times || 1 }} 次
          </el-descriptions-item>
          <el-descriptions-item label="创建人">{{ detailData.contract?.creator_name || '-' }}</el-descriptions-item>
        </el-descriptions>

        <el-divider>合同内容</el-divider>
        <el-card shadow="never">
          <div style="white-space: pre-wrap; line-height: 1.8;">{{ detailData.contract?.content || '-' }}</div>
        </el-card>

        <el-divider>付款条款</el-divider>
        <el-card shadow="never">
          <div style="white-space: pre-wrap; line-height: 1.8;">{{ detailData.contract?.payment_terms || '-' }}</div>
        </el-card>

        <el-divider>付款计划</el-divider>
        <el-table :data="detailData.contract?.payment_plans || []" size="small" max-height="300">
          <el-table-column prop="payment_no" label="期数" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small">第{{ row.payment_no }}期</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="payment_amount" label="金额(元)" width="120" align="right">
            <template #default="{ row }">
              <span style="white-space: nowrap;">{{ formatLargeNumber(row.payment_amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="payment_date" label="付款日期" width="120" />
          <el-table-column prop="payment_status" label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="row.payment_status === 'paid' ? 'success' : 'info'" size="small">
                {{ row.payment_status === 'paid' ? '已付款' : '待付款' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="actual_payment_date" label="实际付款日期" width="120" />
        </el-table>

        <el-divider>回款记录</el-divider>
        <el-table :data="detailData.contract?.payments || []" size="small" max-height="300">
          <el-table-column prop="payment_no" label="回款编号" width="150" />
          <el-table-column prop="type" label="类型" width="100" />
          <el-table-column prop="amount" label="金额(元)" width="120" align="right">
            <template #default="{ row }">
              <span style="white-space: nowrap;">{{ formatLargeNumber(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="actual_date" label="回款日期" width="120" />
          <el-table-column prop="status" label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag :type="row.status === '已回款' ? 'success' : 'info'" size="small">
                {{ row.status === '已回款' ? '已回款' : row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="method" label="方式" width="100" />
        </el-table>
          </el-tab-pane>
          <el-tab-pane label="变更记录">
            <el-table :data="detailData.changeLogs || []" style="width: 100%" v-if="detailData.changeLogs && detailData.changeLogs.length > 0">
              <el-table-column prop="changed_at" label="变更时间" width="160" />
              <el-table-column prop="changed_by_name" label="变更人" width="100" />
              <el-table-column prop="field_name" label="变更字段" width="120" />
              <el-table-column label="变更前值" min-width="200">
                <template #default="{ row }">
                  <span style="color: #f54a45;">{{ row.old_value || '(空)' }}</span>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无变更记录" :image-size="80" />
          </el-tab-pane>
        </el-tabs>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editFromDetail">编辑</el-button>
      </template>
    </el-dialog>

    <!-- 到期提醒对话框 -->
    <el-dialog
      v-model="expiringVisible"
      title="即将到期合同"
      width="800px"
    >
      <el-table :data="expiringList" max-height="400">
        <el-table-column prop="contract_no" label="合同编号" width="150" />
        <el-table-column prop="title" label="合同名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户" width="150" />
        <el-table-column prop="amount" label="金额(元)" width="120" align="right">
          <template #default="{ row }">
            <span style="white-space: nowrap;">{{ formatLargeNumber(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="expire_date" label="到期日期" width="120" />
        <el-table-column label="剩余天数" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.days_until_expire <= 7 ? 'danger' : 'warning'">
              {{ Math.ceil(row.days_until_expire) }}天
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Clock } from '@element-plus/icons-vue'
import request from '@/utils/request'

const route = useRoute()

const loading = ref(false)
const submitting = ref(false)
const detailLoading = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const expiringVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)

const filters = reactive({ customer_name: '', status: 'active', type: '', opportunity_type: '' })
const dateRange = ref([])
const tableData = ref([])
const customerList = ref([])
const contactList = ref([])
const opportunityList = ref([])
const expiringList = ref([])
const expiringCount = ref(0)
const isAdmin = ref(false)
// 是否为运营角色
const isOperations = ref(false)
const pagination = reactive({ page: 1, limit: 10, total: 0 })

const contractForm = reactive({
  id: '', customer_id: '', contact_id: '', opportunity_id: '', title: '', type: '', 
  amount: 0, status: 'active', sign_date: '', effective_date: '',
  expire_date: '', payment_method: '', payment_times: 1,
  payment_plans: [],
  content: '', payment_terms: ''
})

const detailData = ref({})

const rules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  opportunity_id: [{ required: true, message: '请选择关联商机', trigger: 'change' }],
  title: [{ required: true, message: '请输入合同名称', trigger: 'blur' }],
  amount: [{ required: true, message: '请输入合同金额', trigger: 'blur' }],
  sign_date: [{ required: true, message: '请选择签订日期', trigger: 'change' }],
  effective_date: [{ required: true, message: '请选择生效日期', trigger: 'change' }],
  expire_date: [{ required: true, message: '请选择到期日期', trigger: 'change' }],
  payment_method: [{ required: true, message: '请选择付款方式', trigger: 'change' }]
}

const getStatusType = (status) => {
  const map = {
    active: 'primary',
    completed: 'success',
    terminated: 'danger'
  }
  return map[status] || ''
}

const getStatusLabel = (status) => {
  const map = {
    active: '执行中',
    completed: '已完成',
    terminated: '已终止'
  }
  return map[status] || status
}

const getPaymentMethodLabel = (method) => {
  const map = {
    monthly: '按月',
    quarterly: '按季度',
    yearly: '按年',
    per_time: '按次'
  }
  return map[method] || '-'
}

// 格式化大数字，直接显示完整数值
const formatLargeNumber = (num) => {
  num = num || 0
  // 直接显示完整数值，使用千分位分隔符
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

const calculatePaymentProgress = (row) => {
  if (!row.amount || row.amount === 0) return 0
  const received = row.total_received || 0
  return Math.min(100, Math.round((received / row.amount) * 100))
}

const loadData = async () => {
  loading.value = true
  try {
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      ...filters
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.start_date = dateRange.value[0]
      params.end_date = dateRange.value[1]
    }
    const { data } = await request.get('/api/contracts', { params })
    tableData.value = data.data
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载合同列表失败')
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

const loadContacts = async (customerId) => {
  if (!customerId) {
    contactList.value = []
    return
  }
  try {
    const { data } = await request.get('/api/contacts', { params: { customer_id: customerId } })
    contactList.value = data.data || []
  } catch (error) {
    contactList.value = []
  }
}

const handleCustomerChange = (customerId) => {
  // 客户改变时,清空联系人和商机选择
  contractForm.contact_id = ''
  contractForm.opportunity_id = ''
  // 加载该客户的联系人
  loadContacts(customerId)
  // 加载该客户下当前用户创建的商机
  loadOpportunities(customerId)
}

// 加载客户下当前用户创建的商机列表
const loadOpportunities = async (customerId) => {
  try {
    const { data } = await request.get('/api/opportunities', {
      params: { customer_id: customerId, limit: 100 }
    })
    // 只显示当前登录用户创建的商机
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    opportunityList.value = (data.data || []).filter(opp => opp.creator_id === user.id)
  } catch (error) {
    opportunityList.value = []
  }
}

// 生成付款计划
const generatePaymentPlans = () => {
  if (!contractForm.payment_method || !contractForm.sign_date) {
    ElMessage.warning('请先选择付款方式和签订日期')
    return
  }

  const signDate = new Date(contractForm.sign_date)
  const plans = []

  if (contractForm.payment_method === 'per_time') {
    // 按次付款
    const times = contractForm.payment_times || 1
    const amountPerTime = contractForm.amount / times

    for (let i = 0; i < times; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setDate(paymentDate.getDate() + (i + 1) * 30) // 每次间隔 30 天

      plans.push({
        amount: parseFloat(amountPerTime.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'monthly') {
    // 按月付款
    const amount = contractForm.amount / 12
    for (let i = 0; i < 12; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setMonth(paymentDate.getMonth() + i + 1)
      paymentDate.setDate(15) // 每月 15 日付款

      plans.push({
        amount: parseFloat(amount.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'quarterly') {
    // 按季度付款
    const amount = contractForm.amount / 4
    for (let i = 0; i < 4; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setMonth(paymentDate.getMonth() + (i + 1) * 3)
      paymentDate.setDate(15) // 每季度第一个月 15 日付款

      plans.push({
        amount: parseFloat(amount.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'yearly') {
    // 按年付款
    const amount = contractForm.amount
    const paymentDate = new Date(signDate)
    paymentDate.setFullYear(paymentDate.getFullYear() + 1)
    paymentDate.setMonth(11) // 12 月
    paymentDate.setDate(31) // 12 月 31 日付款

    plans.push({
      amount: parseFloat(amount.toFixed(2)),
      date: paymentDate.toISOString().split('T')[0]
    })
  }

  contractForm.payment_plans = plans
  ElMessage.success('付款计划已生成,可手动调整')
}

// 删除付款计划
const removePaymentPlan = (index) => {
  contractForm.payment_plans.splice(index, 1)
}

const loadExpiringContracts = async () => {
  try {
    const { data } = await request.get('/api/contracts/expiring/upcoming', { params: { days: 30 } })
    expiringList.value = data.data
    expiringCount.value = data.total
  } catch (error) {
    expiringList.value = []
    expiringCount.value = 0
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(contractForm, {
    id: '', customer_id: '', contact_id: '', opportunity_id: '', title: '', type: '销售合同',
    amount: 0, status: 'active', sign_date: '', effective_date: '',
    expire_date: '', payment_method: '', payment_times: 1,
    payment_plans: [],
    content: '', payment_terms: ''
  })
  loadCustomers()
  contactList.value = [] // 新增时清空联系人列表
  opportunityList.value = [] // 新增时清空商机列表
  dialogVisible.value = true
}

const editContract = async (row) => {
  isEdit.value = true
  Object.assign(contractForm, {
    id: row.id,
    customer_id: row.customer_id,
    contact_id: row.contact_id,
    opportunity_id: row.opportunity_id,
    title: row.title,
    type: row.type,
    amount: row.amount,
    status: row.status,
    sign_date: row.sign_date,
    effective_date: row.effective_date,
    expire_date: row.expire_date,
    payment_method: row.payment_method || '',
    payment_times: row.payment_times || 1,
    payment_plans: [],
    content: row.content,
    payment_terms: row.payment_terms
  })
  loadCustomers()
  if (row.customer_id) {
    loadContacts(row.customer_id)
    loadOpportunities(row.customer_id)
  }
  // 加载付款计划
  try {
    const { data } = await request.get(`/api/contracts/${row.id}`)
    if (data.contract && data.contract.payment_plans) {
      contractForm.payment_plans = data.contract.payment_plans.map(p => ({
        amount: p.payment_amount,
        date: p.payment_date
      }))
    }
  } catch (error) {
    console.error('加载付款计划失败:', error)
  }
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  // 校验付款计划是否已生成
  if (!contractForm.payment_plans || contractForm.payment_plans.length === 0) {
    ElMessage.error('请先生成付款计划')
    return
  }
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    submitting.value = true
    try {
      const submitData = { ...contractForm }
      // 格式化日期为 YYYY-MM-DD 格式
      if (submitData.sign_date) {
        const d = new Date(submitData.sign_date)
        submitData.sign_date = d.toISOString().split('T')[0]
      }
      if (submitData.effective_date) {
        const d = new Date(submitData.effective_date)
        submitData.effective_date = d.toISOString().split('T')[0]
      }
      if (submitData.expire_date) {
        const d = new Date(submitData.expire_date)
        submitData.expire_date = d.toISOString().split('T')[0]
      }
      // 格式化付款计划日期
      if (submitData.payment_plans && Array.isArray(submitData.payment_plans)) {
        submitData.payment_plans = submitData.payment_plans.map(plan => ({
          amount: plan.amount,
          date: plan.date ? (new Date(plan.date).toISOString().split('T')[0]) : null
        }))
      }
      if (isEdit.value) {
        await request.put(`/api/contracts/${contractForm.id}`, submitData)
        // 更新付款计划
        if (submitData.payment_plans) {
          await request.put(`/api/contracts/${contractForm.id}/payment-plans`, {
            payment_plans: submitData.payment_plans
          })
        }
        ElMessage.success('更新成功')
      } else {
        await request.post('/api/contracts', submitData)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
      loadData()
    } catch (error) {
      console.error('合同操作失败:', error)
      ElMessage.error(error.response?.data?.error || '操作失败')
    } finally {
      submitting.value = false
    }
  })
}

const viewDetail = async (id) => {
  detailLoading.value = true
  try {
    const { data } = await request.get(`/api/contracts/${id}`)
    detailData.value = data
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载详情失败')
  } finally {
    detailLoading.value = false
  }
}

const editFromDetail = () => {
  if (!detailData.value.contract) return
  detailVisible.value = false
  editContract(detailData.value.contract)
}

const deleteContract = async (row) => {
  try {
    await ElMessageBox.confirm('确定要删除该合同吗?', '提示', { type: 'warning' })
    await request.delete(`/api/contracts/${row.id}`)
    ElMessage.success('删除成功')
    loadData()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.error || '删除失败')
  }
}

const showExpiringContracts = () => {
  loadExpiringContracts()
  expiringVisible.value = true
}

const resetFilters = () => {
  Object.assign(filters, { customer_name: '', status: '', type: '', opportunity_type: '' })
  dateRange.value = []
  loadData()
}

onMounted(() => {
  // 支持从 URL query 初始化筛选（数据概览点击跳转时使用）
  if (route.query.status) {
    filters.status = String(route.query.status)
  } else if (route.query.opportunity_type || (route.query.start_date && route.query.end_date)) {
    // 按类型/日期范围跳转时展示全部状态的合同，避免默认只显示执行中
    filters.status = ''
  }
  if (route.query.opportunity_type) filters.opportunity_type = String(route.query.opportunity_type)
  if (route.query.start_date && route.query.end_date) {
    dateRange.value = [String(route.query.start_date), String(route.query.end_date)]
  }
  loadData()
  loadExpiringContracts()
  // 从数据概览「合同到期提醒」进入时，自动打开即将到期弹窗
  if (route.query.show_expiring === '1') {
    expiringVisible.value = true
  }
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  isAdmin.value = ['admin', 'super_admin'].includes(user.role)
  isOperations.value = user.role === 'operations'
})
</script>

<style scoped>
.contract-list {
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

.pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}
</style>
