<template>
  <div class="profile">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>个人信息</span>
        </div>
      </template>

      <el-form :model="userForm" :rules="rules" ref="formRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="用户名">
              <el-input v-model="userForm.username" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="姓名" prop="name">
              <el-input v-model="userForm.name" placeholder="请输入姓名" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="角色">
              <el-input v-model="userForm.role_label" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="手机号" prop="phone">
              <el-input v-model="userForm.phone" placeholder="请输入手机号" maxlength="11" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="邮箱" prop="email">
              <el-input v-model="userForm.email" placeholder="请输入邮箱" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-tag :type="userForm.status === 'active' ? 'success' : 'info'">
                {{ userForm.status === 'active' ? '启用' : '禁用' }}
              </el-tag>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20" v-if="userForm.renew_contract_amount !== undefined">
          <el-col :span="12">
            <el-form-item label="续签合同">
              <el-input-number 
                v-model="userForm.renew_contract_amount" 
                :min="0" 
                :precision="2" 
                :step="1000"
                style="width: 100%"
                disabled
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
                disabled
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20" v-if="userForm.payment_amount !== undefined">
          <el-col :span="12">
            <el-form-item label="回款">
              <el-input-number 
                v-model="userForm.payment_amount" 
                :min="0" 
                :precision="2" 
                :step="1000"
                style="width: 100%"
                disabled
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="利润率" v-if="userForm.profit_rate !== undefined">
              <el-input-number 
                v-model="userForm.profit_rate" 
                :min="0" 
                :max="100" 
                :precision="2" 
                :step="0.1"
                style="width: 100%"
                disabled
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item>
          <el-button type="primary" @click="updateProfile" :loading="updating">保存修改</el-button>
          <el-button @click="showResetPassword">重置密码</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 重置密码对话框 -->
    <el-dialog
      v-model="resetDialogVisible"
      title="重置密码"
      width="400px"
    >
      <el-form :model="resetForm" :rules="resetRules" ref="resetFormRef" label-width="80px">
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input 
            v-model="resetForm.oldPassword" 
            type="password" 
            placeholder="请输入当前密码"
            show-password
          />
        </el-form-item>
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
            placeholder="请再次输入新密码"
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
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const updating = ref(false)
const resetting = ref(false)
const resetDialogVisible = ref(false)
const formRef = ref(null)
const resetFormRef = ref(null)

const userForm = reactive({
  id: '',
  username: '',
  name: '',
  role: '',
  role_label: '',
  email: '',
  phone: '',
  status: '',
  renew_contract_amount: undefined,
  new_contract_amount: undefined,
  payment_amount: undefined,
  profit_rate: undefined
})

const resetForm = reactive({
  oldPassword: '',
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
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  email: [{ validator: validateEmail, trigger: 'blur' }],
  phone: [{ validator: validatePhone, trigger: 'blur' }]
}

const resetRules = {
  oldPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  password: [{ validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
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

const getRoleLabel = (role) => {
  const map = {
    super_admin: '超级管理员',
    admin: '管理员',
    sales: '销售',
    presales: '售前',
    fde: 'FDE',
    fde_admin: 'FDE管理员',
    operations: '运营',
    super_admin: '系统管理员'
  }
  return map[role] || role
}

const loadProfile = async () => {
  try {
    const { data } = await request.get('/api/users/me')
    Object.assign(userForm, {
      id: data.user.id,
      username: data.user.username,
      name: data.user.name,
      role: data.user.role,
      role_label: getRoleLabel(data.user.role),
      email: data.user.email || '',
      phone: data.user.phone || '',
      status: data.user.status,
      renew_contract_amount: data.user.renew_contract_amount,
      new_contract_amount: data.user.new_contract_amount,
      payment_amount: data.user.payment_amount,
      profit_rate: data.user.profit_rate
    })
  } catch (error) {
    ElMessage.error('加载个人信息失败')
  }
}

const updateProfile = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    
    updating.value = true
    try {
      await request.put(`/api/users/${userForm.id}`, {
        name: userForm.name,
        email: userForm.email,
        phone: userForm.phone
      })
      ElMessage.success('更新成功')
      // 更新本地存储的用户信息
      const user = JSON.parse(localStorage.getItem('user') || '{}')
      user.name = userForm.name
      user.email = userForm.email
      user.phone = userForm.phone
      localStorage.setItem('user', JSON.stringify(user))
      loadProfile()
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '更新失败')
    } finally {
      updating.value = false
    }
  })
}

const showResetPassword = () => {
  Object.assign(resetForm, {
    oldPassword: '',
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
      await request.put(`/api/users/${userForm.id}/change-password`, {
        oldPassword: resetForm.oldPassword,
        newPassword: resetForm.password
      })
      ElMessage.success('密码重置成功')
      resetDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '密码重置失败')
    } finally {
      resetting.value = false
    }
  })
}

onMounted(() => {
  loadProfile()
})
</script>

<style scoped>
.profile {
  padding: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
