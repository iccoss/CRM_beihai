<template>
  <div class="contact-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="联系人姓名">
            <el-input v-model="filters.name" placeholder="请输入姓名" clearable />
          </el-form-item>
          <el-form-item label="客户名称">
            <el-input v-model="filters.customer_name" placeholder="请输入客户名称" clearable />
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
          新增联系人
        </el-button>
        <el-button type="warning" @click="showBirthdays">
          🎂
          生日提醒
          <el-badge :value="birthdayCount" :hidden="birthdayCount === 0" type="danger" />
        </el-button>
      </div>

      <el-table 
        class="contact-table"
        :data="tableData" 
        v-loading="loading"
        stripe
      >
        <el-table-column prop="name" label="姓名" min-width="120" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户" min-width="180" show-overflow-tooltip />
        <el-table-column prop="position" label="职位" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.position || '-' }}</template>
        </el-table-column>
        <el-table-column prop="phone" label="手机" width="145">
          <template #default="{ row }">{{ row.phone || '-' }}</template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="210" show-overflow-tooltip>
          <template #default="{ row }">{{ row.email || '-' }}</template>
        </el-table-column>
        <el-table-column prop="wechat" label="微信" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.wechat || '-' }}</template>
        </el-table-column>
        <el-table-column label="KP" width="70" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.is_kp === 1" type="success" size="small">是</el-tag>
            <el-tag v-else type="info" size="small">否</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="生日" width="110" align="center">
          <template #default="{ row }">
            {{ row.birthday ? formatBirthday(row.birthday) : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" align="center" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => handleCommand(cmd, row)" :popper-options="{ modifiers: [{ name: 'computeStyles', options: { adaptive: false } }], strategy: 'fixed' }" popper-class="contact-dropdown">
              <el-button text type="primary" @click.stop>
                更多<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="detail">详情</el-dropdown-item>
                  <el-dropdown-item command="edit">编辑</el-dropdown-item>
                  <el-dropdown-item command="delete" divided v-if="isAdmin">
                    <span style="color: #f54a45;">删除</span>
                  </el-dropdown-item>
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

    <!-- 新增/编辑联系人对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑联系人' : '新增联系人'"
      width="700px"
      :close-on-click-modal="false"
    >
      <el-form :model="contactForm" :rules="rules" ref="formRef" label-width="100px">
        <el-alert
          title="手机、邮箱、微信三者必须至少填写一项"
          type="info"
          :closable="false"
          style="margin-bottom: 15px"
        />
        <el-form-item label="客户" prop="customer_id">
          <el-select
            v-model="contactForm.customer_id"
            placeholder="请选择客户"
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="customer in customerList"
              :key="customer.id"
              :label="customer.name"
              :value="customer.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="contactForm.name" placeholder="请输入联系人姓名" />
        </el-form-item>
        <el-form-item label="职位">
          <el-input v-model="contactForm.position" placeholder="请输入职位" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone" :rules="[{ validator: validateContactInfo, trigger: 'blur' }]">
          <el-input v-model="contactForm.phone" placeholder="请输入手机号（或填写邮箱/微信）" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="contactForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="微信">
          <el-input v-model="contactForm.wechat" placeholder="请输入微信号" />
        </el-form-item>
        <el-form-item label="生日">
          <el-date-picker
            v-model="contactForm.birthday"
            type="date"
            placeholder="选择生日"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="是否 KP">
          <el-switch v-model="contactForm.is_kp" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="contactForm.notes"
            type="textarea"
            :rows="3"
            placeholder="请输入备注"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- 联系人详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="联系人详情"
      width="700px"
    >
      <div v-loading="detailLoading">
        <el-tabs>
          <el-tab-pane label="基本信息">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="姓名">{{ detailData.contact?.name }}</el-descriptions-item>
              <el-descriptions-item label="客户">{{ detailData.contact?.customer_name }}</el-descriptions-item>
              <el-descriptions-item label="职位">{{ detailData.contact?.position || '-' }}</el-descriptions-item>
              <el-descriptions-item label="手机号">{{ detailData.contact?.phone || '-' }}</el-descriptions-item>
              <el-descriptions-item label="邮箱">{{ detailData.contact?.email || '-' }}</el-descriptions-item>
              <el-descriptions-item label="微信">{{ detailData.contact?.wechat || '-' }}</el-descriptions-item>
              <el-descriptions-item label="生日">{{ detailData.contact?.birthday ? formatBirthday(detailData.contact?.birthday) : '-' }}</el-descriptions-item>
              <el-descriptions-item label="是否 KP">
                <el-tag v-if="detailData.contact?.is_kp === 1" type="success">是</el-tag>
                <el-tag v-else type="info">否</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="备注">{{ detailData.contact?.notes || '-' }}</el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>
          <el-tab-pane label="变更记录">
            <el-table :data="detailData.changeLogs" style="width: 100%" v-if="detailData.changeLogs && detailData.changeLogs.length > 0">
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

    <!-- 生日提醒对话框 -->
    <el-dialog
      v-model="birthdayVisible"
      title="生日提醒"
      width="800px"
    >
      <el-table :data="birthdayList" max-height="400">
        <el-table-column prop="name" label="姓名" width="100" />
        <el-table-column prop="customer_name" label="客户" width="150" />
        <el-table-column prop="phone" label="手机" width="120" />
        <el-table-column label="生日" width="100">
          <template #default="{ row }">
            {{ formatBirthday(row.birthday) }}
          </template>
        </el-table-column>
        <el-table-column label="生日日期" width="100">
          <template #default="{ row }">
            {{ row.birthday_date }}
          </template>
        </el-table-column>
        <el-table-column label="剩余天数" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.days_until_birthday <= 7 ? 'danger' : 'success'">
              {{ row.days_until_birthday }}天
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
import { Plus } from '@element-plus/icons-vue'
import request from '@/utils/request'

const route = useRoute()

const loading = ref(false)
const submitting = ref(false)
const detailLoading = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const birthdayVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)

const filters = reactive({ name: '', customer_name: '' })
const tableData = ref([])
const customerList = ref([])
const birthdayList = ref([])
const pagination = reactive({ page: 1, limit: 10, total: 0 })
const isAdmin = ref(false)

const contactForm = reactive({
  id: '', customer_id: '', name: '', position: '', phone: '', 
  email: '', wechat: '', is_kp: 0, birthday: '', notes: ''
})

const detailData = ref({})

const rules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  name: [{ required: true, message: '请输入联系人姓名', trigger: 'blur' }]
}

// 验证手机、邮箱、微信三者必须填一项
const validateContactInfo = (rule, value, callback) => {
  const { phone, email, wechat } = contactForm
  if (!phone && !email && !wechat) {
    callback(new Error('手机、邮箱、微信三者必须至少填写一项'))
  } else {
    callback()
  }
}

const birthdayCount = ref(0)

const formatBirthday = (date) => {
  if (!date) return '-'
  const d = new Date(date)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const loadData = async () => {
  loading.value = true
  try {
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      ...filters
    }
    const { data } = await request.get('/api/contacts', { params })
    tableData.value = data.data
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载联系人列表失败')
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

const loadBirthdays = async () => {
  try {
    const { data } = await request.get('/api/contacts/birthdays/upcoming', { params: { days: 30 } })
    birthdayList.value = data.data
    birthdayCount.value = data.total
  } catch (error) {
    birthdayList.value = []
    birthdayCount.value = 0
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(contactForm, {
    id: '', customer_id: '', name: '', position: '', phone: '',
    email: '', wechat: '', is_kp: 0, birthday: '', notes: ''
  })
  loadCustomers()
  dialogVisible.value = true
}

const editContact = (row) => {
  isEdit.value = true
  Object.assign(contactForm, {
    id: row.id,
    customer_id: row.customer_id,
    name: row.name,
    position: row.position,
    phone: row.phone,
    email: row.email,
    wechat: row.wechat,
    is_kp: row.is_kp,
    birthday: row.birthday,
    notes: row.notes
  })
  loadCustomers()
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  
  // 先验证手机、邮箱、微信三者是否至少填一项
  const { phone, email, wechat } = contactForm
  if (!phone && !email && !wechat) {
    ElMessage.error('手机、邮箱、微信三者必须至少填写一项')
    return
  }
  
  await formRef.value.validate(async (valid) => {
    if (!valid) return
    submitting.value = true
    try {
      const submitData = { ...contactForm }
      if (submitData.birthday) {
        // 使用本地时间格式化，避免时区问题导致日期偏移
        const date = new Date(submitData.birthday)
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        submitData.birthday = `${year}-${month}-${day}`
      }
      if (isEdit.value) {
        await request.put(`/api/contacts/${contactForm.id}`, submitData)
        ElMessage.success('更新成功')
      } else {
        await request.post('/api/contacts', submitData)
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
  detailLoading.value = true
  try {
    const { data } = await request.get(`/api/contacts/${id}`)
    detailData.value = data
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载详情失败')
  } finally {
    detailLoading.value = false
  }
}

const editFromDetail = () => {
  if (!detailData.value.contact) return
  detailVisible.value = false
  editContact(detailData.value.contact)
}

const deleteContact = async (row) => {
  try {
    await ElMessageBox.confirm('确定要删除该联系人吗？', '提示', { type: 'warning' })
    await request.delete(`/api/contacts/${row.id}`)
    ElMessage.success('删除成功')
    loadData()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.error || '删除失败')
  }
}

const handleCommand = (command, row) => {
  if (command === 'detail') {
    viewDetail(row.id)
  } else if (command === 'edit') {
    editContact(row)
  } else if (command === 'delete') {
    deleteContact(row)
  }
}

const showBirthdays = () => {
  loadBirthdays()
  birthdayVisible.value = true
}

const resetFilters = () => {
  Object.assign(filters, { name: '', customer_name: '' })
  loadData()
}

onMounted(() => {
  loadData()
  loadBirthdays()
  // 从数据概览「生日提醒」进入时，自动打开生日提醒弹窗
  if (route.query.show_birthday === '1') {
    birthdayVisible.value = true
  }
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  isAdmin.value = ['admin', 'super_admin'].includes(user.role)
})
</script>

<style scoped>
.contact-list {
  padding: 0;
}

.contact-table :deep(.el-table__cell) {
  vertical-align: middle;
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

:deep(.contact-dropdown.el-popper) {
  z-index: 3000 !important;
}
</style>
