import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useLogin } from './api';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const login = useLogin();
  const navigate = useNavigate();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate(password, {
      onSuccess: () => navigate('/today', { replace: true }),
    });
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-xs space-y-4" noValidate>
        <h1 className="text-lg font-semibold text-foreground">English Review</h1>
        <div className="space-y-2">
          <Label htmlFor="password">访问密码</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        {login.isError && (
          <p className="text-sm text-destructive" role="alert">
            {login.error.message}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={login.isPending || !password}>
          {login.isPending ? '登录中…' : '进入'}
        </Button>
      </form>
    </div>
  );
}
