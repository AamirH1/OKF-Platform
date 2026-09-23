import { Suspense } from 'react';
import { ForgotPasswordForm } from '@/components/auth-forms';

export const metadata = { title: 'Forgot password' };

export default function Page() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
