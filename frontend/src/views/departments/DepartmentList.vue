<template>
  <div class="department-list">
    <el-card>
      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增部门
        </el-button>
      </div>

      <el-table
        :data="tableData"
        v-loading="loading"
        row-key="id"
        :tree-props="{ children: 'children' }"
        style="width: 100%"
      >
        <el-table-column prop="name" label="部门名称" min-width="200" />
        <el-table-column prop="level" label="层级" width="80" align="center" />
        <el-table-column prop="manager_name" label="负责人" width="120" />
        <el-table-column prop="member_count" label="人数" width="80" align="center" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ row.status === 'active' ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="160" />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click.stop="viewDetail(row.id)">详情</el-button>
            <el-button text type="primary" @click.stop="editDepartment(row)">编辑</el-button>
            <el-button 
              text 
              type="danger" 
              @click.stop="deleteDepartment(row)"
              :disabled="row.children && row.children.length > 0"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增/编辑部门对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑部门' : '新增部门'"
      width="500px"
    >
      <el-form :model="departmentForm" :rules="rules" ref="formRef" label-width="100px">
        <el-form-item label="部门名称" prop="name">
          <el-input v-model="departmentForm.name" placeholder="请输入部门名称" />
        </el-form-item>
        <el-form-item label="上级部门" prop="parent_id">
          <el-tree-select
            v-model="departmentForm.parent_id"
            :data="departmentTreeOptions"
            placeholder="请选择上级部门（无则为一级部门）"
            check-strictly
            :render-after-expand="false"
            clearable
            node-key="id"
            :props="{ label: 'name', children: 'children', disabled: 'disabled' }"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="部门负责人">
          <el-select
            v-model="departmentForm.manager_id"
            placeholder="请选择负责人"
            clearable
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="user in userList"
              :key="user.id"
              :label="user.name + ' (' + user.username + ')'"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="departmentForm.sort_order" :min="0" :max="999" />
        </el-form-item>
        <el-form-item label="状态" v-if="isEdit">
          <el-radio-group v-model="departmentForm.status">
            <el-radio label="active">启用</el-radio>
            <el-radio label="disabled">禁用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 部门详情对话框 -->
    <el-dialog v-model="detailVisible" title="部门详情" width="600px">
      <el-descriptions :column="1" border v-if="detailData.department">
        <el-descriptions-item label="部门名称">{{ detailData.department.name }}</el-descriptions-item>
        <el-descriptions-item label="层级">{{ detailData.department.level }}</el-descriptions-item>
        <el-descriptions-item label="负责人">{{ detailData.department.manager_name || '未设置' }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="detailData.department.status === 'active' ? 'success' : 'info'" size="small">
            {{ detailData.department.status === 'active' ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ detailData.department.created_at }}</el-descriptions-item>
      </el-descriptions>
      
      <el-divider>下级部门</el-divider>
      <el-table :data="detailData.children || []" style="width: 100%">
        <el-table-column prop="name" label="部门名称" />
        <el-table-column prop="manager_name" label="负责人" />
      </el-table>
      
      <el-divider>部门成员</el-divider>
      <el-table :data="detailData.members || []" style="width: 100%">
        <el-table-column prop="name" label="姓名" />
        <el-table-column prop="username" label="用户名" />
        <el-table-column prop="role" label="角色" />
        <el-table-column prop="email" label="邮箱" />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)

const tableData = ref([])
const departmentTree = ref([])
const userList = ref([])

const detailData = reactive({
  department: null,
  children: [],
  members: []
})

const departmentForm = reactive({
  id: '',
  name: '',
  parent_id: null,
  manager_id: null,
  sort_order: 0,
  status: 'active'
})

// 转换部门树数据格式，排除当前编辑的部门及其子部门
const departmentTreeOptions = computed(() => {
  if (!departmentForm.id) return departmentTree.value
  
  // 递归排除当前部门及其子部门
  function excludeCurrentDept(departments, excludeId) {
    return departments
      .filter(dept => dept.id !== excludeId)
      .map(dept => ({
        ...dept,
        children: excludeCurrentDept(dept.children || [], excludeId)
      }))
  }
  
  return excludeCurrentDept(departmentTree.value, departmentForm.id)
})

const rules = {
  name: [
    { required: true, message: '请输入部门名称', trigger: 'blur' },
    { min: 2, max: 50, message: '部门名称长度在 2-50 个字符', trigger: 'blur' }
  ]
}

const loadDepartments = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/departments/tree')
    tableData.value = data.data
    departmentTree.value = data.data
  } catch (error) {
    ElMessage.error('加载部门列表失败')
  } finally {
    loading.value = false
  }
}

const loadUsers = async () => {
  try {
    const { data } = await request.get('/api/users', { params: { limit: 100 } })
    userList.value = data.data || []
  } catch (error) {
    // 忽略错误
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(departmentForm, {
    id: '',
    name: '',
    parent_id: null,
    manager_id: null,
    sort_order: 0,
    status: 'active'
  })
  // 确保用户列表已加载
  if (userList.value.length === 0) {
    loadUsers()
  }
  dialogVisible.value = true
}

const editDepartment = (row) => {
  isEdit.value = true
  Object.assign(departmentForm, {
    id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    manager_id: row.manager_id,
    sort_order: row.sort_order,
    status: row.status
  })
  // 确保用户列表已加载
  if (userList.value.length === 0) {
    loadUsers()
  }
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    
    submitting.value = true
    try {
      if (isEdit.value) {
        await request.put(`/api/departments/${departmentForm.id}`, departmentForm)
        ElMessage.success('更新成功')
      } else {
        await request.post('/api/departments', departmentForm)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
      loadDepartments()
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '操作失败')
    } finally {
      submitting.value = false
    }
  })
}

const viewDetail = async (id) => {
  try {
    const { data } = await request.get(`/api/departments/${id}`)
    detailData.department = data.department
    detailData.children = data.children
    detailData.members = data.members
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载部门详情失败')
  }
}

const deleteDepartment = async (row) => {
  try {
    await ElMessageBox.confirm(`确定要删除部门"${row.name}"吗？`, '提示', {
      type: 'warning'
    })
    await request.delete(`/api/departments/${row.id}`)
    ElMessage.success('删除成功')
    loadDepartments()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(error.response?.data?.error || '删除失败')
    }
  }
}

onMounted(() => {
  loadDepartments()
  loadUsers()
})
</script>

<style scoped>
.department-list {
  padding: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}
</style>
