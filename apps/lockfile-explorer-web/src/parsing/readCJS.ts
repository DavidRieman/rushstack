import { IPackageJson } from '../types/IPackageJson';

export const readCJS = async (): Promise<string> => {
  try {
    const response = await fetch(`http://localhost:8091/api/pnpmfile`);
    return await response.text();
  } catch (e) {
    console.error('Could not load cjs file: ', e);
    return 'Missing CJS';
  }
};

export const readPackageJSON = async (projectPath: string): Promise<IPackageJson | null> => {
  try {
    const response = await fetch(`http://localhost:8091/api/package-json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        projectPath
      })
    });
    return await response.json();
    // return JSON.stringify(cjsFile, null, 2);
  } catch (e) {
    console.error('Could not load package json file: ', e);
    return null;
  }
};

export const readParsedCJS = async (projectPath: string): Promise<IPackageJson | null> => {
  try {
    const response = await fetch(`http://localhost:8091/api/package-spec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        projectPath
      })
    });
    return await response.json();

    // return JSON.stringify(parsedPackageJSON, null, 2);
  } catch (e) {
    console.error('Could not load cjs file: ', e);
    return null;
  }
};
