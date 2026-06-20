/*
  Warnings:

  - Added the required column `memberPackageId` to the `Waitlist` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Waitlist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "memberId" INTEGER NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "memberPackageId" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Waitlist_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Waitlist_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Waitlist_memberPackageId_fkey" FOREIGN KEY ("memberPackageId") REFERENCES "MemberPackage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Waitlist" ("createdAt", "id", "memberId", "priority", "scheduleId", "status") SELECT "createdAt", "id", "memberId", "priority", "scheduleId", "status" FROM "Waitlist";
DROP TABLE "Waitlist";
ALTER TABLE "new_Waitlist" RENAME TO "Waitlist";
CREATE UNIQUE INDEX "Waitlist_memberId_scheduleId_key" ON "Waitlist"("memberId", "scheduleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
