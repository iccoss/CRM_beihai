<template>
  <div class="delivery-list">
    <div class="toolbar">
      <el-select v-model="filters.status" clearable placeholder="全部状态" @change="loadData">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="openCreate"><el-icon><Plus /></el-icon>新增交付记录</el-button>
    </div>

    <el-table :data="tableData" v-loading="loading">
      <el-table-column prop="customer_name" label="客户" min-width="150" />
      <el-table-column prop="contract_title" label="合同" min-width="180">
        <template #default="{ row }">{{ row.contract_title }}（{{ row.contract_no }}）</template>
      </el-table-column>
      <el-table-column prop="stage" label="交付阶段" width="120">
        <template #default="{ row }">{{ stageLabel(row.stage) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="110">
        <template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="owner_name" label="售前负责人" width="120" />
      <el-table-column prop="content" label="进展记录" min-width="220" show-overflow-tooltip />
      <el-table-column prop="planned_at" label="计划日期" width="120" />
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }"><el-button text type="primary" @click="openEdit(row)">更新</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '更新交付记录' : '新增交付记录'" width="640px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="关联合同" prop="contract_id">
          <el-select v-model="form.contract_id" filterable style="width:100%" :disabled="Boolean(editingId)">
            <el-option v-for="item in contracts" :key="item.id" :label="`${item.title}（${item.customer_name}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="售前负责人" prop="owner_id">
          <el-select v-model="form.owner_id" style="width:100%">
            <el-option v-for="item in presalesUsers" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="交付阶段" prop="stage"><el-select v-model="form.stage" style="width:100%"><el-option v-for="item in stageOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态" prop="status"><el-select v-model="form.status" style="width:100%"><el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item></el-col>
        </el-row>
        <el-form-item label="计划日期"><el-date-picker v-model="form.planned_at" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="进展记录" prop="content"><el-input v-model="form.content" type="textarea" :rows="4" /></el-form-item>
        <el-form-item label="下一步"><el-input v-model="form.next_action" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import request from '@/utils/request'

const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const editingId = ref('')
const formRef = ref()
const tableData = ref([])
const contracts = ref([])
const presalesUsers = ref([])
const filters = reactive({ status: '' })
const form = reactive({ contract_id: '', owner_id: '', stage: 'technical_handover', status: 'pending', planned_at: '', content: '', next_action: '' })
const stageOptions = [
  { label: '技术交接', value: 'technical_handover' }, { label: '实施交付', value: 'implementation' },
  { label: '客户验收', value: 'acceptance' }, { label: '培训支持', value: 'training' }, { label: '交付完成', value: 'completed' }
]
const statusOptions = [
  { label: '待开始', value: 'pending' }, { label: '进行中', value: 'in_progress' },
  { label: '受阻', value: 'blocked' }, { label: '已完成', value: 'completed' }
]
const rules = { contract_id: [{ required: true, message: '请选择合同' }], owner_id: [{ required: true, message: '请选择售前负责人' }], content: [{ required: true, message: '请填写交付进展' }] }
const stageLabel = value => stageOptions.find(item => item.value === value)?.label || value
const statusLabel = value => statusOptions.find(item => item.value === value)?.label || value
const statusType = value => ({ pending: 'info', in_progress: 'primary', blocked: 'danger', completed: 'success' }[value] || 'info')

async function loadData() {
  loading.value = true
  try { const { data } = await request.get('/api/deliveries', { params: filters }); tableData.value = data.data || [] }
  finally { loading.value = false }
}
async function loadOptions() {
  const [contractRes, userRes] = await Promise.all([
    request.get('/api/contracts', { params: { limit: 200 } }),
    request.get('/api/users', { params: { limit: 100, role: 'presales', status: 'active' } })
  ])
  contracts.value = contractRes.data.data || []
  presalesUsers.value = userRes.data.data || []
}
function resetForm() {
  Object.assign(form, { contract_id: '', owner_id: currentUser.role === 'presales' ? currentUser.id : '', stage: 'technical_handover', status: 'pending', planned_at: '', content: '', next_action: '' })
}
function openCreate() { editingId.value = ''; resetForm(); dialogVisible.value = true }
function openEdit(row) { editingId.value = row.id; Object.assign(form, row); dialogVisible.value = true }
async function submit() {
  await formRef.value.validate()
  submitting.value = true
  try {
    if (editingId.value) await request.put(`/api/deliveries/${editingId.value}`, form)
    else await request.post('/api/deliveries', form)
    ElMessage.success('交付记录已保存'); dialogVisible.value = false; loadData()
  } finally { submitting.value = false }
}
onMounted(() => { loadData(); loadOptions() })
</script>

<style scoped>
.toolbar { display:flex; justify-content:space-between; gap:12px; margin-bottom:16px; }
.toolbar .el-select { width:160px; }
</style>
