import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  auth.captureRedirectTokens();
  await auth.syncFromEnvironment();
  if (auth.isLoggedIn()) return true;
  return inject(Router).createUrlTree(['/login']);
};
