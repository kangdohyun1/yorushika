s=open('shell.html').read()
s=s.replace('/*CSS*/',open('app.css').read()).replace('/*DATA*/',open('data.js').read()).replace('/*APP*/',open('app.js').read())
open('../docs/index.html','w').write(s)
