<template>
  <div class="customer-pool">
    <el-card>
      <template #header>
        <div class="pool-header">
          <el-input
            v-model="searchName"
            placeholder="搜索公海客户，支持按客户名称模糊查询"
            clearable
            class="search-input"
            size="large"
            @clear="onSearch"
            @keyup.enter="onSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
            <template #append>
              <el-button type="primary" @click="onSearch">搜 索</el-button>
            </template>
          </el-input>
          <el-button v-if="canCreatePool" type="primary" class="add-pool-button" @click="openCreateDialog">
            <el-icon><Plus /></el-icon>新增公海客户
          </el-button>
        </div>
      </template>
      <el-table :data="tableData" v-loading="loading">
        <el-table-column prop="name" label="客户名称" />
        <el-table-column prop="type" label="类型">
          <template #default="{ row }">
            {{ getCustomerTypeLabel(row.type) }}
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" />
        <el-table-column v-if="showPoolPresales" label="默认售前（客户级）" min-width="150">
          <template #default="{ row }">
            <span :class="{ 'unassigned-text': !row.presales_names }">{{ row.presales_names || '未指派' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="410">
          <template #default="{ row }">
            <el-button type="info" size="small" @click="viewDetail(row.id)">详情</el-button>
            <el-button v-if="canEditPool" type="primary" plain size="small" @click="openEditDialog(row.id)">编辑</el-button>
            <el-button v-if="canAssignPresales" type="warning" plain size="small" @click="openAssignDialog(row)">设置默认售前</el-button>
            <el-button v-if="canClaim" type="primary" size="small" @click="claimCustomer(row.id)">领取</el-button>
            <el-button 
              v-if="isAdmin" 
              type="danger" 
              size="small" 
              @click="deleteCustomer(row.id)"
            >删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页：支持翻页与每页条数切换，可查看到全部公海客户 -->
      <div class="pagination">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.limit"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="onPageSizeChange"
          @current-change="loadData"
        />
      </div>

      <el-dialog v-model="createVisible" :title="isEditing ? '编辑公海客户' : '新增公海客户'" width="720px" :close-on-click-modal="false">
        <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="130px">
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="客户名称" prop="name"><el-input v-model="createForm.name" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户简称" prop="customer_short_name"><el-input v-model="createForm.customer_short_name" /></el-form-item></el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="统一社会信用代码" prop="credit_code"><el-input v-model="createForm.credit_code" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户类型" prop="type"><el-select v-model="createForm.type" style="width:100%"><el-option label="直客" value="direct_customer" /><el-option label="外部渠道客户" value="external_channel" /><el-option label="公司渠道客户" value="company_channel" /></el-select></el-form-item></el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="所属行业" prop="industry"><el-select v-model="createForm.industry" style="width:100%"><el-option v-for="item in industries" :key="item" :label="item" :value="item" /></el-select></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="所在地区" prop="region"><el-input v-model="createForm.region" placeholder="例如：北京市" /></el-form-item></el-col>
          </el-row>
          <el-form-item label="渠道名称" v-if="createForm.type !== 'direct_customer'" prop="channel_name"><el-input v-model="createForm.channel_name" /></el-form-item>
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="客户来源" prop="source"><el-select v-model="createForm.source" style="width:100%"><el-option v-for="item in sources" :key="item" :label="item" :value="item" /></el-select></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="公司电话"><el-input v-model="createForm.company_phone" /></el-form-item></el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="12"><el-form-item label="联系人" prop="contact_person"><el-input v-model="createForm.contact_person" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="联系电话" prop="phone"><el-input v-model="createForm.phone" /></el-form-item></el-col>
          </el-row>
          <el-row v-if="showPoolPresales && (canAssignPresales || (!isEditing && canCreatePool))" :gutter="16">
            <el-col :span="12">
              <el-form-item label="默认售前">
                <el-select v-model="createForm.presales_user_id" clearable filterable placeholder="暂不指派" style="width:100%">
                  <el-option v-for="item in presalesUsers" :key="item.id" :label="item.name" :value="item.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="指派备注">
                <el-input v-model="createForm.presales_remark" maxlength="200" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="备注"><el-input v-model="createForm.notes" type="textarea" :rows="3" /></el-form-item>
        </el-form>
        <template #footer><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :loading="createSubmitting" @click="submitCreate">{{ isEditing ? '保存修改' : '保存' }}</el-button></template>
      </el-dialog>

      <!-- 公海客户详情对话框 -->
      <el-dialog
        v-model="detailVisible"
        title="公海客户详情"
        width="900px"
        :close-on-click-modal="false"
      >
        <div v-loading="detailLoading">
          <el-descriptions title="基本信息" :column="2" border>
            <el-descriptions-item label="客户名称">{{ detailData.customer?.name }}</el-descriptions-item>
            <el-descriptions-item label="客户类型">{{ detailData.customer?.type || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户简称">{{ detailData.customer?.customer_short_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="所属行业">{{ detailData.customer?.industry || '-' }}</el-descriptions-item>
            <el-descriptions-item label="所在地区">{{ detailData.customer?.region || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户来源">{{ detailData.customer?.source || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户等级">{{ detailData.customer?.level || '-' }}</el-descriptions-item>
            <el-descriptions-item label="预算范围">{{ detailData.customer?.budget_range || '-' }}</el-descriptions-item>
          </el-descriptions>

          <el-divider v-if="showPoolPresales">客户级默认售前</el-divider>
          <div v-if="showPoolPresales" class="presales-assignment">
            <div>
              <span class="assignment-caption">默认售前</span>
              <strong>{{ currentPresalesName }}</strong>
              <span v-if="detailData.presales_assignments?.[0]?.assigned_by_name" class="assignment-note">
                由 {{ detailData.presales_assignments[0].assigned_by_name }} 指派
              </span>
            </div>
            <div v-if="canAssignPresales" class="assignment-actions">
              <el-button type="primary" plain size="small" @click="openAssignDialog(detailData.customer)">修改默认售前</el-button>
              <el-button v-if="detailData.presales_assignments?.length" type="danger" plain size="small" @click="cancelPresalesAssignment">取消指派</el-button>
            </div>
          </div>

          <el-divider>联系信息</el-divider>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="公司地址">{{ detailData.customer?.address || '-' }}</el-descriptions-item>
            <el-descriptions-item label="公司电话">{{ detailData.customer?.company_phone || '-' }}</el-descriptions-item>
            <el-descriptions-item label="公司官网">
              <el-link v-if="detailData.customer?.website" type="primary" :href="detailData.customer?.website" target="_blank">
                {{ detailData.customer?.website }}
              </el-link>
              <span v-else>-</span>
            </el-descriptions-item>
            <el-descriptions-item label="联系人">{{ detailData.customer?.contact_person || '-' }}</el-descriptions-item>
            <el-descriptions-item label="联系电话">{{ detailData.customer?.phone || '-' }}</el-descriptions-item>
          </el-descriptions>

          <el-divider>公海信息</el-divider>
          <el-alert type="warning" :closable="false" show-icon>
            <div style="line-height: 2;">
              <div><strong>移入公海时间：</strong>{{ detailData.customer?.public_at || '-' }}</div>
              <div v-if="detailData.customer?.public_reason"><strong>移入原因：</strong>{{ detailData.customer?.public_reason }}</div>
              <div><strong>保护天数：</strong>{{ detailData.customer?.protect_days || 0 }} 天</div>
            </div>
          </el-alert>

          <el-divider>客户联系人</el-divider>
          <el-table :data="detailData.contacts || []" size="small" max-height="200">
            <el-table-column prop="name" label="姓名" width="100" />
            <el-table-column prop="position" label="职位" width="100" />
            <el-table-column prop="phone" label="手机" width="120" />
            <el-table-column prop="email" label="邮箱" min-width="150" />
            <el-table-column prop="wechat" label="微信" width="100" />
            <el-table-column label="KP" width="60" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.is_kp === 1" type="success" size="small">是</el-tag>
                <el-tag v-else type="info" size="small">否</el-tag>
              </template>
            </el-table-column>
          </el-table>

          <el-divider>历史跟进记录</el-divider>
          <el-table :data="detailData.followups || []" size="small" max-height="300">
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
            <el-table-column prop="stage" label="阶段" width="100">
              <template #default="{ row }">
                <el-tag size="small">{{ row.stage }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="result" label="结果" width="100">
              <template #default="{ row }">
                <el-tag size="small">{{ row.result }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="user_name" label="跟进人" width="130">
              <template #default="{ row }">
                {{ row.user_name }}
                <el-tag v-if="row.user_role" size="small" :type="row.user_role === 'sales' ? '' : row.user_role === 'presales' ? 'success' : row.user_role === 'fde' ? 'warning' : row.user_role === 'fde_admin' ? 'danger' : 'info'" style="margin-left: 4px;">
                  {{ { sales: '销售', presales: '售前', fde: 'FDE', fde_admin: 'FDE管理员', admin: '管理员', super_admin: '超管', operations: '运营', after_sales: '售后' }[row.user_role] || row.user_role }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="canAddPresalesFollowup" class="presales-followup-form">
            <div class="followup-form-title">新增售前跟进</div>
            <el-form label-width="88px">
              <el-row :gutter="16">
                <el-col :span="8">
                  <el-form-item label="跟进方式">
                    <el-select v-model="followupForm.type" placeholder="请选择" style="width: 100%">
                      <el-option v-for="item in followupTypes" :key="item" :label="item" :value="item" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="16">
                  <el-form-item label="联系人">
                    <el-select v-model="followupForm.contact_id" clearable placeholder="可不选择" style="width: 100%">
                      <el-option v-for="item in detailData.contacts || []" :key="item.id" :label="item.name" :value="item.id" />
                    </el-select>
                  </el-form-item>
                </el-col>
              </el-row>
              <el-form-item label="跟进内容">
                <el-input v-model="followupForm.content" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="至少填写10个字" />
              </el-form-item>
              <div class="followup-submit-row">
                <el-button type="primary" :loading="followupSubmitting" @click="submitPresalesFollowup">保存跟进</el-button>
              </div>
            </el-form>
          </div>
        </div>

        <template #footer>
          <el-button @click="detailVisible = false">关闭</el-button>
          <el-button v-if="canClaim" type="primary" @click="claimCurrentCustomer">领取客户</el-button>
        </template>
      </el-dialog>

      <el-dialog v-if="showPoolPresales" v-model="assignVisible" title="设置客户级默认售前" width="480px" :close-on-click-modal="false">
        <el-form label-width="90px">
          <el-form-item label="公海客户">
            <el-input :model-value="assignCustomer.name" disabled />
          </el-form-item>
          <el-form-item label="默认售前" required>
            <el-select v-model="assignForm.user_id" filterable placeholder="请选择售前" style="width: 100%">
              <el-option v-for="item in presalesUsers" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="指派备注">
            <el-input v-model="assignForm.remark" type="textarea" :rows="3" maxlength="200" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="assignVisible = false">取消</el-button>
          <el-button type="primary" :loading="assignSubmitting" @click="submitPresalesAssignment">确定指派</el-button>
        </template>
      </el-dialog>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import request from '@/utils/request'

const router = useRouter()
const loading = ref(false)
const detailLoading = ref(false)
const detailVisible = ref(false)
const currentCustomerId = ref('')
const tableData = ref([])
const detailData = ref({})
const isAdmin = ref(false)
const currentRole = ref('')
const searchName = ref('')
// 列表分页状态（后端 /pool/list 已支持 page/limit，返回 pagination.total）
const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})
const createVisible = ref(false)
const createSubmitting = ref(false)
const createFormRef = ref(null)
const isEditing = ref(false)
const editingCustomerId = ref('')
const assignVisible = ref(false)
const assignSubmitting = ref(false)
const assignCustomer = ref({})
const assignForm = ref({ user_id: '', remark: '' })
const presalesUsers = ref([])
const followupSubmitting = ref(false)
const followupTypes = ['电话', '微信', '邮件', '拜访', '会议', '其他']
const followupForm = ref({ type: '', contact_id: '', content: '' })
// 公海客户级售前总开关。售前已统一收敛到「商机管理」按商机指派，公海阶段不再指派售前。
// 如需恢复公海客户级售前，把该开关改为 true 即可，下方原有实现全部保留。
const showPoolPresales = false
const canAssignPresales = computed(() => showPoolPresales && ['sales', 'admin', 'super_admin'].includes(currentRole.value))
const canEditPool = computed(() => ['sales', 'admin', 'super_admin'].includes(currentRole.value))
const canClaim = computed(() => currentRole.value === 'sales')
const canCreatePool = computed(() => ['sales', 'admin', 'super_admin', 'operations'].includes(currentRole.value))
const currentPresalesName = computed(() => detailData.value.presales_assignments?.map(item => item.name).join('、') || '未指派')
const canAddPresalesFollowup = computed(() => {
  if (!showPoolPresales) return false
  if (['admin', 'super_admin'].includes(currentRole.value)) return true
  return currentRole.value === 'presales'
    && detailData.value.presales_assignments?.some(item => item.user_id === JSON.parse(localStorage.getItem('user') || '{}').id)
})
const industries = ['互联网平台', '汽车', '智能制造', '银行', '证券', '保险', '消金', '基金', '零售', '政府', '其他']
const sources = ['线上咨询', '线下活动', '客户介绍', '市场活动', '其他']
const createForm = ref({
  name: '', customer_short_name: '', credit_code: '', type: 'direct_customer', industry: '', region: '',
  channel_name: '', source: '', company_phone: '', contact_person: '', phone: '', notes: '',
  presales_user_id: '', presales_remark: ''
})
const createRules = {
  name: [{ required: true, message: '请输入客户名称', trigger: 'blur' }],
  customer_short_name: [{ required: true, message: '请输入客户简称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择客户类型', trigger: 'change' }],
  industry: [{ required: true, message: '请选择所属行业', trigger: 'change' }],
  region: [{ required: true, message: '请输入所在地区', trigger: 'blur' }],
  source: [{ required: true, message: '请选择客户来源', trigger: 'change' }],
  contact_person: [{ required: true, message: '请输入联系人', trigger: 'blur' }],
  phone: [
    { required: true, message: '请输入联系电话', trigger: 'blur' }
  ],
  channel_name: [{ required: true, message: '请输入渠道名称', trigger: 'blur' }]
}

// 获取客户类型标签
const getCustomerTypeLabel = (type) => {
  const map = {
    external_channel: '外部渠道客户',
    direct_customer: '直客',
    company_channel: '公司渠道客户',
    enterprise: '企业客户',
    individual: '个人客户'
  }
  return map[type] || type || '-'
}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/customers/pool/list', {
      params: {
        page: pagination.page,
        limit: pagination.limit,
        name: searchName.value || undefined
      }
    })
    tableData.value = data.data
    pagination.total = data.pagination?.total || 0
  } catch (error) {
    console.error('加载公海客户失败:', error)
    console.error('错误详情:', error.response?.data)
    
    const errorMsg = error.response?.data?.error || 
                     error.message || 
                     '加载公海客户失败'
    
    if (error.response?.status === 401) {
      ElMessage.error('登录已过期，请重新登录')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      router.push('/login')
    } else {
      ElMessage.error(errorMsg)
    }
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  // 搜索条件变化后必须回到第 1 页，否则可能停留在超出范围的页码上看到空列表
  pagination.page = 1
  loadData()
}

// 切换每页条数时同样回到第 1 页，避免当前页码超出新的总页数
const onPageSizeChange = () => {
  pagination.page = 1
  loadData()
}

// 领取/删除成功后该客户会离开公海列表：
// 若当前处于末页且这一页只剩它一条，先回退一页再刷新，避免看到空白页
const reloadAfterRemove = () => {
  if (tableData.value.length === 1 && pagination.page > 1) pagination.page--
  loadData()
}

const openCreateDialog = () => {
  isEditing.value = false
  editingCustomerId.value = ''
  createForm.value = {
    name: '', customer_short_name: '', credit_code: '', type: 'direct_customer', industry: '', region: '',
    channel_name: '', source: '', company_phone: '', contact_person: '', phone: '', notes: '',
    presales_user_id: '', presales_remark: ''
  }
  createVisible.value = true
  if ((canAssignPresales.value || canCreatePool.value) && !presalesUsers.value.length) loadPresalesUsers().catch(() => ElMessage.error('加载售前人员失败'))
}

const openEditDialog = async (id) => {
  try {
    const { data } = await request.get(`/api/customers/pool/${id}`)
    const customer = data.customer || {}
    const assignment = data.presales_assignments?.[0] || {}
    isEditing.value = true
    editingCustomerId.value = id
    createForm.value = {
      name: customer.name || '',
      customer_short_name: customer.customer_short_name || '',
      credit_code: customer.credit_code || '',
      type: customer.type || 'direct_customer',
      industry: customer.industry || '',
      region: customer.region || '',
      channel_name: customer.channel_name || '',
      source: customer.source || '',
      company_phone: customer.company_phone || '',
      contact_person: customer.contact_person || '',
      phone: customer.phone || '',
      notes: customer.notes || '',
      presales_user_id: assignment.user_id || '',
      presales_remark: assignment.remark || ''
    }
    createVisible.value = true
    if (!presalesUsers.value.length) loadPresalesUsers().catch(() => ElMessage.error('加载售前人员失败'))
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载公海客户失败')
  }
}

const submitCreate = async () => {
  if (!createFormRef.value) return
  await createFormRef.value.validate()
  createSubmitting.value = true
  try {
    if (isEditing.value) {
      await request.put(`/api/customers/pool/${editingCustomerId.value}`, createForm.value)
      ElMessage.success('公海客户更新成功')
    } else {
      await request.post('/api/customers/pool/create', createForm.value)
      ElMessage.success('公海客户创建成功')
    }
    createVisible.value = false
    loadData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '创建失败')
  } finally {
    createSubmitting.value = false
  }
}

const claimCustomer = async (id) => {
  try {
    console.log('领取客户:', id)
    await request.post('/api/customers/pool/claim', { customer_ids: [id] })
    console.log('领取成功')
    ElMessage.success('领取成功')
    reloadAfterRemove()
  } catch (error) {
    console.error('领取失败:', error)
    console.error('错误详情:', error.response?.data)
    
    const errorMsg = error.response?.data?.error || 
                     error.message || 
                     '领取失败'
    
    if (error.response?.status === 401) {
      ElMessage.error('登录已过期，请重新登录')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      router.push('/login')
    } else {
      ElMessage.error(errorMsg)
    }
  }
}

const viewDetail = async (id) => {
  currentCustomerId.value = id
  detailLoading.value = true
  
  try {
    // 使用公海客户详情 API
    const { data } = await request.get(`/api/customers/pool/${id}`)
    detailData.value = data
    followupForm.value = { type: '', contact_id: '', content: '' }
    detailVisible.value = true
  } catch (error) {
    console.error('加载公海客户详情失败:', error)
    const errorMsg = error.response?.data?.error || '加载详情失败'
    ElMessage.error(errorMsg)
  } finally {
    detailLoading.value = false
  }
}

const loadPresalesUsers = async () => {
  if (!canAssignPresales.value && !canCreatePool.value) return
  const { data } = await request.get('/api/users', { params: { role: 'presales', status: 'active', limit: 100 } })
  presalesUsers.value = data.data || []
}

const openAssignDialog = (customer) => {
  assignCustomer.value = customer || {}
  assignForm.value = {
    user_id: detailData.value.customer?.id === customer?.id ? (detailData.value.presales_assignments?.[0]?.user_id || '') : '',
    remark: ''
  }
  assignVisible.value = true
  if (!presalesUsers.value.length) loadPresalesUsers().catch(() => ElMessage.error('加载售前人员失败'))
}

const submitPresalesAssignment = async () => {
  if (!assignForm.value.user_id) return ElMessage.warning('请选择售前人员')
  assignSubmitting.value = true
  try {
    await request.post(`/api/customers/pool/${assignCustomer.value.id}/presales`, assignForm.value)
    ElMessage.success('售前指派成功')
    assignVisible.value = false
    await loadData()
    if (detailVisible.value && currentCustomerId.value === assignCustomer.value.id) await viewDetail(currentCustomerId.value)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '指派失败')
  } finally {
    assignSubmitting.value = false
  }
}

const cancelPresalesAssignment = async () => {
  await ElMessageBox.confirm('确定取消该客户当前的售前指派吗？', '取消指派', { type: 'warning' })
  try {
    await request.post(`/api/customers/pool/${currentCustomerId.value}/presales/cancel`)
    ElMessage.success('已取消售前指派')
    await loadData()
    await viewDetail(currentCustomerId.value)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '取消失败')
  }
}

const submitPresalesFollowup = async () => {
  if (!followupForm.value.type) return ElMessage.warning('请选择跟进方式')
  if (followupForm.value.content.trim().length < 10) return ElMessage.warning('跟进内容至少填写10个字')
  followupSubmitting.value = true
  try {
    await request.post(`/api/customers/${currentCustomerId.value}/presales-followups`, followupForm.value)
    ElMessage.success('售前跟进已保存')
    await viewDetail(currentCustomerId.value)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存跟进失败')
  } finally {
    followupSubmitting.value = false
  }
}

const claimCurrentCustomer = async () => {
  if (!currentCustomerId.value) return
  
  try {
    await request.post('/api/customers/pool/claim', { customer_ids: [currentCustomerId.value] })
    ElMessage.success('领取成功')
    detailVisible.value = false
    reloadAfterRemove()
  } catch (error) {
    console.error('领取失败:', error)
    const errorMsg = error.response?.data?.error || '领取失败'
    ElMessage.error(errorMsg)
  }
}

const deleteCustomer = async (id) => {
  ElMessageBox.confirm('确定要删除该公海客户吗？此操作将物理删除客户及其所有关联数据（联系人、跟进记录等），无法恢复！', '警告', {
    confirmButtonText: '确定删除',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await request.delete(`/api/customers/pool/${id}`)
      ElMessage.success('删除成功')
      reloadAfterRemove()
    } catch (error) {
      console.error('删除失败:', error)
      const errorMsg = error.response?.data?.error || '删除失败'
      ElMessage.error(errorMsg)
    }
  }).catch(() => {})
}

onMounted(() => {
  loadData()
  // 检查是否为管理员
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  currentRole.value = user.role || ''
  isAdmin.value = ['admin', 'super_admin'].includes(user.role)
  loadPresalesUsers().catch(() => {})
})
</script>

<style scoped>
.customer-pool {
  padding: 0;
}

/* 分页条：与客户列表页保持一致的右对齐样式 */
.pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}

.pool-header {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
}

.pool-header .search-input {
  width: min(700px, 100%);
  font-size: 16px;
}

.add-pool-button { flex-shrink: 0; }

.unassigned-text { color: #8f959e; }

.presales-assignment {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  background: #f8f9fa;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
}

.assignment-caption { color: #646a73; margin-right: 12px; }
.assignment-note { color: #8f959e; font-size: 12px; margin-left: 12px; }
.assignment-actions { display: flex; flex-shrink: 0; }
.presales-followup-form { margin-top: 18px; padding: 16px; border-top: 1px solid #e5e6eb; background: #f8f9fa; }
.followup-form-title { margin-bottom: 14px; font-weight: 600; color: #1f2329; }
.followup-submit-row { display: flex; justify-content: flex-end; }

.pool-header :deep(.el-input__wrapper) {
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  transition: all 0.3s ease;
}

.pool-header :deep(.el-input__wrapper:hover) {
  box-shadow: 0 4px 16px rgba(51, 112, 255, 0.2);
}

.pool-header :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 4px 20px rgba(51, 112, 255, 0.35);
}

.pool-header :deep(.el-input__inner) {
  font-size: 15px;
}
</style>
