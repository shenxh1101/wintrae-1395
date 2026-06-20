import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  await prisma.noShow.deleteMany()
  await prisma.feedback.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.booking.deleteMany()
  await prisma.memberPackage.deleteMany()
  await prisma.schedule.deleteMany()
  await prisma.coursePackage.deleteMany()
  await prisma.trainer.deleteMany()
  await prisma.member.deleteMany()
  await prisma.store.deleteMany()

  const store1 = await prisma.store.create({
    data: { name: '阳光旗舰店', address: '朝阳路100号', phone: '010-88880001' },
  })
  const store2 = await prisma.store.create({
    data: { name: '海淀学院店', address: '学院路50号', phone: '010-88880002' },
  })
  const store3 = await prisma.store.create({
    data: { name: '国贸CBD店', address: '国贸大厦B1', phone: '010-88880003' },
  })

  const t1 = await prisma.trainer.create({
    data: { name: '李强', phone: '13800001111', specialties: '增肌,力量', storeId: store1.id },
  })
  const t2 = await prisma.trainer.create({
    data: { name: '王芳', phone: '13800002222', specialties: '瑜伽,普拉提', storeId: store1.id },
  })
  const t3 = await prisma.trainer.create({
    data: { name: '赵明', phone: '13800003333', specialties: '减脂,HIIT', storeId: store2.id },
  })
  const t4 = await prisma.trainer.create({
    data: { name: '孙丽', phone: '13800004444', specialties: '康复,拉伸', storeId: store3.id },
  })

  const m1 = await prisma.member.create({
    data: { name: '张伟', phone: '13900001111', gender: '男', birthday: new Date('1995-03-15') },
  })
  const m2 = await prisma.member.create({
    data: { name: '刘洋', phone: '13900002222', gender: '女', birthday: new Date('1998-07-22') },
  })
  const m3 = await prisma.member.create({
    data: { name: '陈静', phone: '13900003333', gender: '女', birthday: new Date('2000-11-08') },
  })

  const pkg1 = await prisma.coursePackage.create({
    data: { name: '私教20节', totalSlots: 20, priceCents: 800000, description: '20节一对一私教课' },
  })
  const pkg2 = await prisma.coursePackage.create({
    data: { name: '私教50节', totalSlots: 50, priceCents: 1750000, description: '50节一对一私教课' },
  })
  const pkg3 = await prisma.coursePackage.create({
    data: { name: '体验课3节', totalSlots: 3, priceCents: 29900, description: '新会员体验3节私教课' },
  })

  await prisma.memberPackage.createMany({
    data: [
      { memberId: m1.id, packageId: pkg1.id, remainSlots: 12, expireAt: new Date('2026-12-31') },
      { memberId: m1.id, packageId: pkg3.id, remainSlots: 1, expireAt: new Date('2026-09-30') },
      { memberId: m2.id, packageId: pkg2.id, remainSlots: 38, expireAt: new Date('2027-06-30') },
      { memberId: m3.id, packageId: pkg1.id, remainSlots: 20, expireAt: new Date('2027-03-31') },
    ],
  })

  const today = new Date()
  const scheduleData: any[] = []
  for (let d = 0; d < 7; d++) {
    const date = new Date(today)
    date.setDate(date.getDate() + d)
    const dateStr = date.toISOString().slice(0, 10)

    for (const trainer of [t1, t2, t3, t4]) {
      const slots = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']
      for (const start of slots) {
        const h = parseInt(start.split(':')[0])
        const end = `${String(h + 1).padStart(2, '0')}:00`
        scheduleData.push({
          trainerId: trainer.id,
          storeId: trainer.storeId,
          date: new Date(dateStr),
          startAt: start,
          endAt: end,
          isBooked: false,
        })
      }
    }
  }
  await prisma.schedule.createMany({ data: scheduleData })

  console.log('Seed data created successfully')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
