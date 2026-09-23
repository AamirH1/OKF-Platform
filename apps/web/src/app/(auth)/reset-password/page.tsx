import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/auth-forms';

export const metadata = { title: 'Reset password' };

export default function Page() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
