import { prisma } from './prisma'
import dayjs from 'dayjs'

export const CONFIRM_WINDOW_MINUTES = 30

export async function promoteNextWaitlist(scheduleId: number): Promise<{ memberId: number; waitlistId: number } | null> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId }, include: { trainer: true } })
  if (!schedule) return null

  const currentPending = await prisma.waitlist.findFirst({
    where: { scheduleId, status: 'pending_confirm' },
  })
  if (currentPending) return null

  const now = new Date()

  const waitingList = await prisma.waitlist.findMany({
    where: { scheduleId, status: 'waiting' },
    include: { memberPackage: true, member: true },
    orderBy: { priority: 'asc' },
  })

  for (const w of waitingList) {
    const mp = w.memberPackage

    if (mp.remainSlots <= 0) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      const rest = await prisma.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) await prisma.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      continue
    }
    if (mp.expireAt && mp.expireAt < schedule.date) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      const rest = await prisma.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) await prisma.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      continue
    }
    if (mp.expireAt && mp.expireAt < now) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      const rest = await prisma.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) await prisma.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      continue
    }

    const conflict = await prisma.booking.findFirst({
      where: {
        memberId: w.memberId,
        status: { in: ['booked', 'checked_in'] },
        schedule: { date: schedule.date, startAt: schedule.startAt },
      },
    })
    if (conflict) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      const rest = await prisma.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) await prisma.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      continue
    }

    const expireAt = dayjs().add(CONFIRM_WINDOW_MINUTES, 'minute').toDate()

    await prisma.$transaction(async (tx) => {
      await tx.waitlist.update({
        where: { id: w.id },
        data: { status: 'pending_confirm', confirmExpireAt: expireAt, priority: 0 },
      })
      const rest = await tx.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) {
        await tx.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      }
    })

    await prisma.notification.create({
      data: {
        memberId: w.memberId,
        type: 'waitlist_promoted',
        title: '候补待确认',
        content: `您候补的 ${dayjs(schedule.date).format('MM-DD')} ${schedule.startAt}-${schedule.endAt} ${schedule.trainer.name} 教练课程有名额了！请在 ${CONFIRM_WINDOW_MINUTES} 分钟内确认，超时将让给其他候补会员`,
      },
    })

    return { memberId: w.memberId, waitlistId: w.id }
  }

  const anyPendingOrActive = await prisma.booking.findFirst({
    where: { scheduleId, status: { in: ['booked', 'checked_in'] } },
  })
  if (!anyPendingOrActive && schedule.isBooked) {
    await prisma.schedule.update({ where: { id: scheduleId }, data: { isBooked: false } })
  }

  return null
}
