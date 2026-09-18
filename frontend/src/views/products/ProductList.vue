<template>
  <div class="product-list">
    <el-card>
      <template #header>
        <div class="table-header">
          <span style="font-weight:bold">产品管理</span>
          <div>
            <el-input v-model="filter.name" placeholder="搜索名称" clearable style="width:160px;margin-right:8px" @keyup.enter="load"/>
            <el-button type="primary" @click="load">搜索</el-button>
            <el-button type="primary" @click="openDialog()">+ 新增产品</el-button>
          </div>
        </div>
      </template>

      <el-table :data="tableData" stripe v-loading="loading">
        <el-table-column prop="name" label="产品名称" min-width="140"/>
        <el-table-column label="单价(元)" width="120" align="right">
          <template #default="{ row }">¥{{ fmt(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column label="数量" width="80" align="center"><template #default="{ row }">{{ row.quantity }}</template></el-table-column>
        <el-table-column label="研发成本(%)" width="110" align="center"><template #default="{ row }">{{ row.r_and_d_cost_rate }}%</template></el-table-column>
        <el-table-column prop="description" label="功能解释" min-width="200" show-overflow-tooltip/>
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDialog(row)">编辑</el-button>
            <el-button size="small" :type="row.status === 'active' ? 'warning' : 'success'" @click="toggleStatus(row)">
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination style="margin-top:16px;text-align:right" background layout="total,prev,pager,next"
        :total="pagination.total" :page-size="pagination.limit" :current-page="pagination.page" @current-change="pageChange"/>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing.id ? '编辑产品' : '新增产品'" width="550px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="产品名称"><el-input v-model="form.name"/></el-form-item>
        <el-form-item label="单价(元)"><el-input-number v-model="form.unit_price" :min="0" :precision="2" :step="1000" style="width:100%"/></el-form-item>
        <el-form-item label="数量"><el-input-number v-model="form.quantity" :min="1" style="width:100%"/></el-form-item>
        <el-form-item label="研发成本(%)"><el-input-number v-model="form.r_and_d_cost_rate" :min="0" :max="100" :precision="1" style="width:100%"/></el-form-item>
        <el-form-item label="功能解释"><el-input v-model="form.description" type="textarea" :rows="3"/></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

// 运营角色只读：写操作按钮置灰禁用
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const isOperations = currentUser.role === 'operations'

const loading = ref(false)
const tableData = ref([])
const pagination = reactive({ total: 0, page: 1, limit: 20 })
const filter = reactive({ name: '' })
const dialogVisible = ref(false)
const editing = ref({})
const form = reactive({ name: '', unit_price: 0, quantity: 1, r_and_d_cost_rate: 0, description: '' })

const fmt = (v) => { const n = Number(v) || 0; return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

const load = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/products', { params: { ...filter, page: pagination.page, limit: pagination.limit } })
    tableData.value = data.data || []
    pagination.total = data.pagination.total
  } catch (e) { ElMessage.error('加载失败') }
  finally { loading.value = false }
}
const pageChange = (p) => { pagination.page = p; load() }

const openDialog = (row) => {
  if (row) { editing.value = { id: row.id }; Object.assign(form, { name: row.name, unit_price: row.unit_price, quantity: row.quantity, r_and_d_cost_rate: row.r_and_d_cost_rate, description: row.description || '' }) }
  else { editing.value = {}; Object.assign(form, { name: '', unit_price: 0, quantity: 1, r_and_d_cost_rate: 0, description: '' }) }
  dialogVisible.value = true
}
const save = async () => {
  if (!form.name) return ElMessage.warning('请输入产品名称')
  try {
    if (editing.value.id) { await request.put(`/api/products/${editing.value.id}`, form); ElMessage.success('更新成功') }
    else { await request.post('/api/products', form); ElMessage.success('创建成功') }
    dialogVisible.value = false; load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '操作失败') }
}
const toggleStatus = async (row) => {
  try {
    const newStatus = row.status === 'active' ? 'inactive' : 'active'
    const msg = newStatus === 'inactive' ? `确定停用产品「${row.name}」？` : `确定启用产品「${row.name}」？`
    await ElMessageBox.confirm(msg, '提示', { type: 'warning' })
    await request.put(`/api/products/${row.id}`, { status: newStatus })
    ElMessage.success(newStatus === 'inactive' ? '已停用' : '已启用')
    load()
  } catch (e) {}
}

onMounted(load)
</script>

<style scoped>
.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}
</style>
