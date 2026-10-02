import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { TokensPage } from '../src/features/tokens/TokensPage';

afterEach(cleanup);

function renderAtTokens() {
  return render(
    <MemoryRouter initialEntries={['/tokens']}>
      <Routes>
        <Route path="/tokens" element={<TokensPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/tokens 色卡页（全局设计基元权威展示）', () => {
  it('五节标题齐全', async () => {
    renderAtTokens();
    for (const h of ['色板', '按钮矩阵', '判语语义色', '字号层级', 'Diff 色']) {
      expect(await screen.findByRole('heading', { name: h })).toBeVisible();
    }
  });

  it('按钮矩阵渲染五个变体与禁用态', async () => {
    renderAtTokens();
    for (const label of ['primary', 'neutral', 'negative', 'destructive', 'ghost']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /禁用/ })).toBeDisabled();
  });

  it('色板每项含变量名', async () => {
    renderAtTokens();
    // exact 精确匹配 <code> 内的变量名：exact:false 是子串匹配，会把 --accent-soft 一起匹配进来
    expect(await screen.findByText('--accent')).toBeInTheDocument();
    expect(screen.getByText('--destructive')).toBeInTheDocument();
  });
});
