<template>
  <div class="user-list">
    <el-card>
      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增用户
        </el-button>
      </div>

      <el-table :data="tableData" v-loading="loading">
        <el-table-column prop="username" label="用户名" min-width="120" />
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column prop="role" label="角色" width="100">
          <template #default="{ row }">
            <el-tag :type="getRoleType(row.role)" size="small">
              {{ getRoleLabel(row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="renew_contract_amount" label="续签合同(元)" width="180" align="right">
          <template #default="{ row }">
            <span v-if="row.renew_contract_amount" style="white-space: nowrap;">{{ (row.renew_contract_amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="new_contract_amount" label="新签合同(元)" width="180" align="right">
          <template #default="{ row }">
            <span v-if="row.new_contract_amount" style="white-space: nowrap;">{{ (row.new_contract_amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="payment_amount" label="回款(元)" width="180" align="right">
          <template #default="{ row }">
            <span v-if="row.payment_amount" style="white-space: nowrap;">{{ (row.payment_amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="customer_quota" label="客户数量" width="100" align="center">
          <template #default="{ row }">
            <span>{{ row.customer_quota || 30 }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="profit_rate" label="利润率" width="100" align="right" v-if="currentUser?.role === 'admin' || currentUser?.role === 'super_admin'">
          <template #default="{ row }">
            <span v-if="row.profit_rate !== undefined">{{ (row.profit_rate || 0).toFixed(2) }}%</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="季度营业额(元)" width="160" align="right" v-if="currentUser?.role === 'admin' || currentUser?.role === 'super_admin'">
          <template #default="{ row }">
            <span v-if="row.role === 'sales'">{{ (row.quarter_target || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="150" />
        <el-table-column prop="phone" label="手机号" width="120" />
        <el-table-column prop="status" label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ row.status === 'active' ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="160" />
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click">
              <el-button text type="primary" size="small">操作 ▾</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="editUser(row)">编辑</el-dropdown-item>
                  <el-dropdown-item @click="resetPassword(row)">重置密码</el-dropdown-item>
                  <!-- FDE管理员无权删除与自己平权的FDE管理员账号，因此隐藏该行的删除入口 -->
                  <el-dropdown-item v-if="row.username !== 'admin' && !(isFdeAdmin && row.role === 'fde_admin')" style="color: #f54a45" @click="deleteUser(row)">删除</el-dropdown-item>
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

    <!-- 新增/编辑用户对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑用户' : '新增用户'"
      width="600px"
    >
      <el-form :model="userForm" :rules="rules" ref="formRef" label-width="100px">
        <el-form-item label="用户名" prop="username" v-if="!isEdit">
          <el-input v-model="userForm.username" placeholder="6-20 位字母和数字" />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="userForm.name" placeholder="请输入姓名" />
        </el-form-item>
        <el-form-item label="密码" prop="password" v-if="!isEdit">
          <el-input 
            v-model="userForm.password" 
            type="password" 
            placeholder="6-16 位，包含字母和数字"
            show-password
          />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="userForm.role" placeholder="请选择角色" style="width: 100%">
            <!-- FDE管理员只能新增/编辑FDE与自己平权的FDE管理员用户，因此对其隐藏其它角色选项 -->
            <template v-if="!isFdeAdmin">
              <el-option label="超级管理员" value="super_admin" />
              <el-option label="管理员" value="admin" />
              <el-option label="销售" value="sales" />
              <el-option label="运营" value="operations" />
              <el-option label="售前" value="presales" />
            </template>
            <el-option label="FDE" value="fde" />
            <el-option label="FDE管理员" value="fde_admin" />
          </el-select>
        </el-form-item>
        <el-form-item label="部门">
          <el-tree-select
            v-model="userForm.department_id"
            :data="departmentTree"
            placeholder="请选择部门"
            check-strictly
            clearable
            node-key="id"
            :props="{ label: 'name', children: 'children' }"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="userForm.phone" placeholder="11 位手机号" maxlength="11" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="userForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="状态" v-if="isEdit">
          <el-radio-group v-model="userForm.status">
            <el-radio label="active">启用</el-radio>
            <el-radio label="disabled">禁用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-row :gutter="20" v-if="isEdit && (currentUser?.role === 'admin' || currentUser?.role === 'super_admin')">
          <el-col :span="12">
            <el-form-item label="续签合同">
              <el-input-number 
                v-model="userForm.renew_contract_amount" 
                :min="0" 
                :precision="2" 
                :step="1000"
                style="width: 100%"
                placeholder="请输入续签合同金额"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="新签合同">
              <el-input-number 
                v-model="userForm.new_contract_amount" 
                :min="0" 
                :precision="2" 
                :step="1000"
                style="width: 100%"
                placeholder="请输入新签合同金额"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20" v-if="isEdit && (currentUser?.role === 'admin' || currentUser?.role === 'super_admin')">
          <el-col :span="12">
            <el-form-item label="回款">
              <el-input-number 
                v-model="userForm.payment_amount" 
                :min="0" 
                :precision="2" 
                :step="1000"
                style="width: 100%"
                placeholder="请输入回款金额"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="利润率">
              <el-input-number 
                v-model="userForm.profit_rate" 
                :min="0" 
                :max="100" 
                :precision="2" 
                :step="0.1"
                style="width: 100%"
                placeholder="请输入利润率百分比"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12" v-if="userForm.role === 'sales'">
            <el-form-item label="季度营业额(元)">
              <el-input-number 
                v-model="userForm.quarter_target" 
                :min="0" 
                :precision="0"
                :step="10000"
                style="width: 100%"
                placeholder="请输入季度营业额"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20" v-if="isEdit && (currentUser?.role === 'admin' || currentUser?.role === 'super_admin')">
          <el-col :span="12">
            <el-form-item label="客户数量">
              <el-input-number 
                v-model="userForm.customer_quota" 
                :min="0" 
                :step="1"
                style="width: 100%"
                placeholder="请输入客户数量限制"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input
            v-model="userForm.remark"
            type="textarea"
            :rows="3"
            placeholder="请输入备注信息"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码对话框 -->
    <el-dialog
      v-model="resetDialogVisible"
      title="重置密码"
      width="400px"
    >
      <el-form :model="resetForm" :rules="resetRules" ref="resetFormRef" label-width="80px">
        <el-form-item label="新密码" prop="password">
          <el-input 
            v-model="resetForm.password" 
            type="password" 
            placeholder="6-16 位，包含字母和数字"
            show-password
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input 
            v-model="resetForm.confirmPassword" 
            type="password" 
            placeholder="请再次输入密码"
            show-password
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReset" :loading="resetting">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

const loading = ref(false)
const submitting = ref(false)
const resetting = ref(false)
const dialogVisible = ref(false)
const resetDialogVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)
const resetFormRef = ref(null)

const tableData = ref([])
const departmentTree = ref([])
const currentUser = ref(null)
// FDE管理员只能管理FDE角色用户，不能查看/操作其它角色的用户
const isFdeAdmin = computed(() => currentUser.value?.role === 'fde_admin')

const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const userForm = reactive({
  id: '',
  username: '',
  password: '',
  name: '',
  role: 'sales',
  department_id: null,
  phone: '',
  email: '',
  status: 'active',
  remark: '',
  renew_contract_amount: 0,
  new_contract_amount: 0,
  payment_amount: 0,
  profit_rate: 0,
  quarter_target: 0,
  customer_quota: 30
})

const resetForm = reactive({
  user_id: '',
  password: '',
  confirmPassword: ''
})

const validatePassword = (rule, value, callback) => {
  if (!value) {
    callback(new Error('请输入密码'))
  } else if (value.length < 6 || value.length > 18) {
    callback(new Error('密码长度必须在 6-18 位之间'))
  } else {
    let types = 0
    if (/[a-z]/.test(value)) types++
    if (/[A-Z]/.test(value)) types++
    if (/[0-9]/.test(value)) types++
    if (/[^a-zA-Z0-9]/.test(value)) types++
    if (types < 3) {
      callback(new Error('密码必须包含以下 4 种字符类型中的至少 3 种：小写字母、大写字母、数字、特殊字符'))
    } else {
      callback()
    }
  }
}

const validateEmail = (rule, value, callback) => {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    callback(new Error('请输入正确的邮箱格式'))
  } else {
    callback()
  }
}

const validatePhone = (rule, value, callback) => {
  if (value && !/^1[3-9]\d{9}$/.test(value)) {
    callback(new Error('请输入正确的手机号'))
  } else {
    callback()
  }
}

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 6, max: 20, message: '用户名长度在 6-20 位', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9]+$/, message: '用户名只能包含字母和数字', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  password: [{ validator: validatePassword, trigger: 'blur' }],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
  email: [{ validator: validateEmail, trigger: 'blur' }],
  phone: [{ validator: validatePhone, trigger: 'blur' }]
}

const resetRules = {
  password: [{ validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [
    { required: true, message: '请确认密码', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (value !== resetForm.password) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

const getRoleType = (role) => {
  const map = {
    super_admin: 'danger',
    admin: 'warning',
    sales: '',
    operations: 'warning',
    presales: 'primary',
    fde: 'success',
    fde_admin: 'danger'
  }
  return map[role] || ''
}

const getRoleLabel = (role) => {
  const map = {
    super_admin: '超级管理员',
    admin: '管理员',
    sales: '销售',
    operations: '运营',
    presales: '售前',
    fde: 'FDE',
    fde_admin: 'FDE管理员'
  }
  return map[role] || role
}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/users', {
      params: {
        page: pagination.page,
        limit: pagination.limit
      }
    })
    tableData.value = data.data
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载用户列表失败')
  } finally {
    loading.value = false
  }
}

const loadDepartments = async () => {
  try {
    const { data } = await request.get('/api/departments/tree')
    departmentTree.value = data.data
  } catch (error) {
    // 忽略错误
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(userForm, {
    id: '',
    username: '',
    password: '',
    name: '',
    // FDE管理员新增用户时，角色默认为FDE（下拉框中可选择FDE或FDE管理员）
    role: isFdeAdmin.value ? 'fde' : 'sales',
    department_id: null,
    phone: '',
    email: '',
    status: 'active',
    remark: '',
    renew_contract_amount: 0,
    new_contract_amount: 0,
    payment_amount: 0,
    profit_rate: 0,
    quarter_target: 0,
    customer_quota: 30
  })
  dialogVisible.value = true
}

const editUser = (row) => {
  isEdit.value = true
  Object.assign(userForm, {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    department_id: row.department_id,
    phone: row.phone,
    email: row.email,
    status: row.status,
    remark: row.remark || '',
    renew_contract_amount: row.renew_contract_amount || 0,
    new_contract_amount: row.new_contract_amount || 0,
    payment_amount: row.payment_amount || 0,
    profit_rate: row.profit_rate || 0,
    quarter_target: row.quarter_target || 0,
    customer_quota: row.customer_quota || 30
  })
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    
    submitting.value = true
    try {
      if (isEdit.value) {
        await request.put(`/api/users/${userForm.id}`, userForm)
        ElMessage.success('更新成功')
      } else {
        const createData = {
          username: userForm.username,
          password: userForm.password,
          name: userForm.name,
          role: userForm.role,
          department_id: userForm.department_id,
          phone: userForm.phone,
          email: userForm.email,
          remark: userForm.remark
        }
        await request.post('/api/users', createData)
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

const resetPassword = (row) => {
  Object.assign(resetForm, {
    user_id: row.id,
    password: '',
    confirmPassword: ''
  })
  resetDialogVisible.value = true
}

const submitReset = async () => {
  if (!resetFormRef.value) return
  
  await resetFormRef.value.validate(async (valid) => {
    if (!valid) return
    
    resetting.value = true
    try {
      await request.post(`/api/users/${resetForm.user_id}/reset-password`, {
        password: resetForm.password
      })
      ElMessage.success('密码重置成功')
      resetDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '操作失败')
    } finally {
      resetting.value = false
    }
  })
}

const deleteUser = async (row) => {
  try {
    await ElMessageBox.confirm(`确定要删除用户"${row.name}"吗？`, '提示', {
      type: 'warning'
    })
    await request.delete(`/api/users/${row.id}`)
    ElMessage.success('删除成功')
    loadData()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error.response?.data?.error || '删除失败')
    }
  }
}

onMounted(async () => {
  loadData()
  loadDepartments()
  // 获取当前用户信息
  const { data } = await request.get('/api/users/me')
  currentUser.value = data.user
})
</script>

<style scoped>
.user-list {
  padding: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
  padding-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border-light);
}

.pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}
</style>
