<template>
  <div class="channel-list">
    <el-card>
      <template #header>
        <div class="table-header">
          <span style="font-weight:bold">渠道管理</span>
          <div>
            <el-select v-model="filter.type" clearable placeholder="类型" style="width:130px;margin-right:8px" @change="load">
              <el-option v-for="t in channelTypes" :key="t.key" :label="t.label" :value="t.key"/>
            </el-select>
            <el-select v-model="filter.status" clearable placeholder="状态" style="width:100px;margin-right:8px" @change="load">
              <el-option label="启用" value="active"/>
              <el-option label="停用" value="inactive"/>
            </el-select>
            <el-input v-model="filter.name" placeholder="搜索名称" clearable style="width:160px;margin-right:8px" @clear="load" @keyup.enter="load"/>
            <el-button type="primary" @click="load">搜索</el-button>
            <el-button type="primary" @click="openDialog()">+ 新增渠道</el-button>
          </div>
        </div>
      </template>

      <el-table :data="tableData" stripe v-loading="loading">
        <el-table-column prop="code" label="编号" width="90"/>
        <el-table-column prop="name" label="渠道名称" min-width="140">
          <template #default="{ row }">
            <el-link type="primary" @click="viewDetail(row)">{{ row.name }}</el-link>
          </template>
        </el-table-column>
        <el-table-column prop="type_label" label="类型" width="100"/>
        <el-table-column prop="contact_person" label="联系人" width="100"/>
        <el-table-column prop="contact_phone" label="电话" width="120"/>
        <el-table-column prop="region" label="区域" width="100"/>
        <el-table-column prop="commission_rate" label="分成比例" width="100" align="right">
          <template #default="{ row }">{{ row.commission_rate }}%</template>
        </el-table-column>
        <el-table-column prop="customer_count" label="客户数" width="80" align="center"/>
        <el-table-column prop="contract_amount" label="合同金额" width="130" align="right">
          <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
        </el-table-column>
        <el-table-column prop="commission_amount" label="渠道分成" width="120" align="right">
          <template #default="{ row }" style="color:#34c724;font-weight:bold">¥{{ fmt(row.commission_amount) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination style="margin-top:16px;text-align:right" background layout="total,prev,pager,next"
        :total="pagination.total" :page-size="pagination.limit" :current-page="pagination.page" @current-change="pageChange"/>
    </el-card>

    <!-- 新增/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="editing.id ? '编辑渠道' : '新增渠道'" width="600px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="渠道编号"><el-input v-model="form.code" :disabled="!!editing.id"/></el-form-item>
        <el-form-item label="渠道名称"><el-input v-model="form.name"/></el-form-item>
        <el-form-item label="渠道类型">
          <el-select v-model="form.type">
            <el-option v-for="t in channelTypes" :key="t.key" :label="t.label" :value="t.key"/>
          </el-select>
        </el-form-item>
        <el-form-item label="分成比例(%)"><el-input-number v-model="form.commission_rate" :min="0" :max="100" :precision="1"/></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contact_person"/></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.contact_phone"/></el-form-item>
        <el-form-item label="邮箱"><el-input v-model="form.contact_email"/></el-form-item>
        <el-form-item label="负责区域"><el-input v-model="form.region"/></el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio :value="'active'">启用</el-radio>
            <el-radio :value="'inactive'">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.description" type="textarea" :rows="3"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 渠道详情抽屉 -->
    <el-drawer v-model="detailVisible" title="渠道详情" size="60%">
      <el-descriptions :column="2" border v-if="detail.channel">
        <el-descriptions-item label="渠道编号">{{ detail.channel.code }}</el-descriptions-item>
        <el-descriptions-item label="渠道名称">{{ detail.channel.name }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ detail.channel.type_label }}</el-descriptions-item>
        <el-descriptions-item label="分成比例">{{ detail.channel.commission_rate }}%</el-descriptions-item>
        <el-descriptions-item label="联系人">{{ detail.channel.contact_person }}</el-descriptions-item>
        <el-descriptions-item label="电话">{{ detail.channel.contact_phone }}</el-descriptions-item>
        <el-descriptions-item label="区域">{{ detail.channel.region }}</el-descriptions-item>
        <el-descriptions-item label="创建人">{{ detail.channel.creator_name }}</el-descriptions-item>
      </el-descriptions>

      <el-row :gutter="16" style="margin:16px 0">
        <el-col :span="6"><el-card shadow="hover"><div class="metric-value">{{ detail.stats?.customer_count || 0 }}</div><div class="metric-label">客户数</div></el-card></el-col>
        <el-col :span="6"><el-card shadow="hover"><div class="metric-value">{{ detail.stats?.opp_count || 0 }}</div><div class="metric-label">商机数</div></el-card></el-col>
        <el-col :span="6"><el-card shadow="hover"><div class="metric-value">{{ detail.stats?.signed_count || 0 }}</div><div class="metric-label">已签</div></el-card></el-col>
        <el-col :span="6"><el-card shadow="hover"><div class="metric-value" style="color:#34c724">¥{{ fmt(detail.stats?.contract_amount) }}</div><div class="metric-label">合同金额</div></el-card></el-col>
      </el-row>
      <div style="margin-bottom:16px"><span style="font-weight:bold;color:#34c724">渠道分成: ¥{{ fmt(detail.stats?.commission_amount) }}</span></div>

      <!-- 关联销售 -->
      <h4 style="margin:16px 0 8px">关联销售</h4>
      <el-table :data="detail.members || []" stripe style="margin-bottom:12px">
        <el-table-column prop="user_name" label="姓名" width="120"/>
        <el-table-column prop="role" label="角色" width="90">
          <template #default="{ row }">
            <el-tag :type="row.role === 'primary' ? 'danger' : ''" size="small">{{ row.role === 'primary' ? '主销售' : '共享' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="assigned_at" label="加入时间" width="170"/>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <template v-if="isAdmin">
              <el-button v-if="row.role !== 'primary'" size="small" @click="setMemberRole(row.user_id, 'primary')">设为主销售</el-button>
              <el-button size="small" type="danger" @click="removeMember(row.user_id)">移除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="isAdmin" style="margin-bottom:16px">
        <el-select v-model="addMember.userId" filterable placeholder="选择销售" style="width:160px;margin-right:8px">
          <el-option v-for="u in allSalesUsers" :key="u.id" :label="u.name" :value="u.id"/>
        </el-select>
        <el-select v-model="addMember.role" style="width:120px;margin-right:8px">
          <el-option label="主销售" value="primary"/>
          <el-option label="共享" value="member"/>
        </el-select>
        <el-button type="primary" @click="addMemberToChannel">添加</el-button>
      </div>

      <!-- 渠道客户 -->
      <h4 style="margin:16px 0 8px">渠道客户</h4>
      <el-table :data="detail.customers || []" stripe>
        <el-table-column prop="opp_name" label="商机名称" min-width="160">
          <template #default="{ row }">{{ row.opp_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="customer_name" label="客户名称" min-width="140"/>
        <el-table-column label="商机金额" width="130" align="right">
          <template #default="{ row }">¥{{ fmt(row.opp_amount) }}</template>
        </el-table-column>
        <el-table-column label="合同金额" width="130" align="right">
          <template #default="{ row }">¥{{ fmt(row.contract_amount) }}</template>
        </el-table-column>
        <el-table-column label="分成比率" width="100" align="right">
          <template #default="{ row }">{{ row.commission_rate }}%</template>
        </el-table-column>
        <el-table-column label="渠道分成" width="130" align="right">
          <template #default="{ row }" style="color:#34c724;font-weight:bold">¥{{ fmt(row.channel_commission) }}</template>
        </el-table-column>
      </el-table>

      <div style="margin-top:16px">
        <el-select v-model="assignCustomer" filterable placeholder="选择客户分配到此渠道" style="width:200px;margin-right:8px">
          <el-option v-for="c in unassignedCustomers" :key="c.id" :label="c.name" :value="c.id"/>
        </el-select>
        <el-button type="primary" @click="assignCustomerToChannel">分配</el-button>
      </div>

      <!-- 编辑日志 -->
      <h4 style="margin:16px 0 8px">编辑日志</h4>
      <el-empty v-if="!detail.changeLogs || detail.changeLogs.length === 0" description="暂无编辑日志" :image-size="60" />
      <el-table v-else :data="detail.changeLogs" stripe size="small" max-height="250">
        <el-table-column prop="changed_at" label="时间" width="170"/>
        <el-table-column prop="changed_by_name" label="操作人" width="100"/>
        <el-table-column prop="field_name" label="修改字段" width="120"/>
        <el-table-column label="修改前" min-width="150">
          <template #default="{ row }"><span style="color:#f54a45">{{ row.old_value || '(空)' }}</span></template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <!-- 商机详情弹窗 -->
    <el-dialog v-model="oppDialogVisible" :title="`${oppDialogData.customer?.name || ''} - 商机详情`" width="800px">
      <el-table :data="oppDialogData.opportunities" stripe v-loading="!oppDialogData.customer">
        <el-table-column prop="name" label="商机名称" min-width="160"/>
        <el-table-column label="金额" width="120" align="right">
          <template #default="{ row }">¥{{ fmt(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'signed' ? 'success' : row.status === 'lost' ? 'danger' : 'warning'">{{ row.status === 'signed' ? '已签' : row.status === 'lost' ? '丢失' : '跟进中' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sales_name" label="跟进人" width="100"/>
        <el-table-column prop="created_at" label="创建时间" width="160"/>
      </el-table>
      <el-empty v-if="oppDialogData.opportunities.length === 0" description="暂无商机" />
    </el-dialog>

    <!-- 合同详情弹窗 -->
    <el-dialog v-model="contractDialogVisible" :title="`${contractDialogData.customer?.name || ''} - 合同详情`" width="900px">
      <el-table :data="contractDialogData.contracts" stripe v-loading="!contractDialogData.customer">
        <el-table-column prop="code" label="合同编号" width="120"/>
        <el-table-column prop="name" label="合同名称" min-width="160"/>
        <el-table-column label="金额" width="120" align="right">
          <template #default="{ row }">¥{{ fmt(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : row.status === 'completed' ? 'info' : 'danger'">{{ row.status === 'active' ? '执行中' : row.status === 'completed' ? '已完成' : '已终止' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="签订日期" width="120">
          <template #default="{ row }">{{ fmtDate(row.sign_date) }}</template>
        </el-table-column>
        <el-table-column label="开始日期" width="120">
          <template #default="{ row }">{{ fmtDate(row.start_date) }}</template>
        </el-table-column>
        <el-table-column label="结束日期" width="120">
          <template #default="{ row }">{{ fmtDate(row.end_date) }}</template>
        </el-table-column>
        <el-table-column prop="sales_name" label="销售" width="100"/>
      </el-table>
      <el-empty v-if="contractDialogData.contracts.length === 0" description="暂无合同" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import request from '@/utils/request'
import { ElMessage, ElMessageBox } from 'element-plus'

const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const isAdmin = computed(() => ['admin', 'super_admin'].includes(user.value?.role))

const loading = ref(false)
const tableData = ref([])
const pagination = reactive({ total: 0, page: 1, limit: 10 })
const filter = reactive({ name: '', type: '', status: '' })
const dialogVisible = ref(false)
const editing = ref({})
const form = reactive({ code: '', name: '', type: 'agent', commission_rate: 10, contact_person: '', contact_phone: '', contact_email: '', region: '', status: 'active', description: '' })
const channelTypes = ref([])

const detailVisible = ref(false)
const detail = reactive({ channel: null, customers: [], members: [], stats: {}, changeLogs: [] })
const assignCustomer = ref('')
const unassignedCustomers = ref([])
const allSalesUsers = ref([])
const addMember = reactive({ userId: '', role: 'member' })

// 商机/合同详情弹窗
const oppDialogVisible = ref(false)
const oppDialogData = reactive({ customer: null, opportunities: [] })
const contractDialogVisible = ref(false)
const contractDialogData = reactive({ customer: null, contracts: [] })

const fmt = (v) => (v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })

const showOppDetail = async (row) => {
  try {
    const { data } = await request.get(`/api/channels/customers/${row.id}/opportunities`)
    oppDialogData.customer = data.customer
    oppDialogData.opportunities = data.opportunities || []
    oppDialogVisible.value = true
  } catch (e) { ElMessage.error('加载商机详情失败') }
}

const showContractDetail = async (row) => {
  try {
    const { data } = await request.get(`/api/channels/customers/${row.id}/contracts`)
    contractDialogData.customer = data.customer
    contractDialogData.contracts = data.contracts || []
    contractDialogVisible.value = true
  } catch (e) { ElMessage.error('加载合同详情失败') }
}

const fmtDate = (d) => {
  if (!d) return '-'
  const date = new Date(d)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}

const load = async (p) => {
  loading.value = true
  try {
    const params = { page: p || pagination.page, limit: pagination.limit, ...filter }
    const { data } = await request.get('/api/channels', { params })
    tableData.value = data.data || []
    pagination.total = data.pagination?.total || 0
  } catch (e) { ElMessage.error('加载失败') }
  finally { loading.value = false }
}

const pageChange = (p) => { pagination.page = p; load() }

const openDialog = (row) => {
  editing.value = row ? { ...row } : {}
  if (row) {
    Object.assign(form, { code: row.code, name: row.name, type: row.type, commission_rate: row.commission_rate, contact_person: row.contact_person, contact_phone: row.contact_phone, contact_email: row.contact_email, region: row.region, status: row.status, description: row.description })
  } else {
    Object.assign(form, { code: '', name: '', type: 'agent', commission_rate: 10, contact_person: '', contact_phone: '', contact_email: '', region: '', status: 'active', description: '' })
  }
  dialogVisible.value = true
}

const save = async () => {
  try {
    if (editing.value.id) {
      await request.put(`/api/channels/${editing.value.id}`, form)
      ElMessage.success('更新成功')
    } else {
      await request.post('/api/channels', form)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '操作失败') }
}

const viewDetail = async (row) => {
  try {
    const { data } = await request.get(`/api/channels/${row.id}`)
    Object.assign(detail, data)
    // 获取未分配客户
    const { data: custResp } = await request.get('/api/customers', { params: { page: 1, limit: 100 } })
    unassignedCustomers.value = (custResp?.data || custResp?.data?.data || []).filter(c => !c.channel_id)
    // 获取所有销售
    if (!allSalesUsers.value.length) {
      const { data: usersResp } = await request.get('/api/users', { params: { page: 1, limit: 100 } })
      allSalesUsers.value = (usersResp?.data || []).filter(u => u.role === 'sales' && u.status === 'active')
    }
    detailVisible.value = true
  } catch (e) { ElMessage.error('加载详情失败') }
}

const assignCustomerToChannel = async () => {
  if (!assignCustomer.value) return ElMessage.warning('请选择客户')
  try {
    await request.post(`/api/channels/${detail.channel.id}/assign`, { customer_id: assignCustomer.value })
    ElMessage.success('分配成功')
    viewDetail(detail.channel)
  } catch (e) { ElMessage.error(e.response?.data?.error || '分配失败') }
}

const removeCustomer = async (row) => {
  try {
    await ElMessageBox.confirm(`确定从渠道移除客户「${row.name}」？`, '提示', { type: 'warning' })
    await request.delete(`/api/channels/${detail.channel.id}/assign/${row.id}`)
    ElMessage.success('移除成功')
    viewDetail(detail.channel)
  } catch (e) {}
}

const addMemberToChannel = async () => {
  if (!addMember.userId) return ElMessage.warning('请选择销售')
  try {
    await request.post(`/api/channels/${detail.channel.id}/members`, { user_id: addMember.userId, member_role: addMember.role })
    ElMessage.success('添加成功')
    viewDetail(detail.channel)
  } catch (e) { ElMessage.error(e.response?.data?.error || '添加失败') }
}

const removeMember = async (userId) => {
  try {
    await ElMessageBox.confirm('确定移除该销售？', '提示', { type: 'warning' })
    await request.delete(`/api/channels/${detail.channel.id}/members/${userId}`)
    ElMessage.success('移除成功')
    viewDetail(detail.channel)
  } catch (e) {}
}

const setMemberRole = async (userId, role) => {
  try {
    await request.put(`/api/channels/${detail.channel.id}/members/${userId}/role`, { role })
    ElMessage.success('角色已更新')
    viewDetail(detail.channel)
  } catch (e) { ElMessage.error(e.response?.data?.error || '操作失败') }
}

const updateCustomerCommission = async (row, rate) => {
  try {
    await request.put(`/api/channels/${detail.channel.id}/customer/${row.id}/commission`, { commission_rate: rate })
    ElMessage.success('分成比例已更新')
    viewDetail(detail.channel)
  } catch (e) { ElMessage.error(e.response?.data?.error || '更新失败') }
}

(async () => {
  const { data } = await request.get('/api/channels/types')
  channelTypes.value = data.data || data
  load()
})()
</script>

<style scoped>
.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.metric-value {
  font-size: 24px;
  font-weight: bold;
}

.metric-label {
  font-size: 13px;
  color: #646a73;
  margin-top: var(--spacing-xs);
}
</style>
