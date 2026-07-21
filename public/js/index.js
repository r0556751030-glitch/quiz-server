function showTab(tab) {

    const isLogin = tab === 'login';


    document
    .getElementById('tabLogin')
    .classList
    .toggle('active', isLogin);


    document
    .getElementById('tabRegister')
    .classList
    .toggle('active', !isLogin);



    document
    .getElementById('loginForm')
    .classList
    .toggle('active', isLogin);



    document
    .getElementById('registerForm')
    .classList
    .toggle('active', !isLogin);


}






document
.getElementById('loginForm')
.addEventListener('submit', async (e)=>{


    e.preventDefault();



    const errEl =
    document.getElementById('loginError');


    errEl.textContent = '';



    try {


        const res =
        await fetch('/admin/login', {


            method:'POST',


            headers:{
                'Content-Type':'application/json'
            },


            body:JSON.stringify({

                username:
                document
                .getElementById('loginUsername')
                .value
                .trim(),


                password:
                document
                .getElementById('loginPassword')
                .value

            })


        });



        const data =
        await res.json();



        if(!res.ok){

            errEl.textContent =
            data.error || 'שגיאה בכניסה';

            return;

        }



        location.href =
        '/games.html';



    }


    catch {


        errEl.textContent =
        'שגיאת רשת - נסו שוב';


    }


});









document
.getElementById('registerForm')
.addEventListener('submit', async (e)=>{


    e.preventDefault();



    const errEl =
    document.getElementById('registerError');


    errEl.textContent='';



    try{


        const res =
        await fetch('/admin/register', {


            method:'POST',


            headers:{
                'Content-Type':'application/json'
            },


            body:JSON.stringify({

                username:
                document
                .getElementById('regUsername')
                .value
                .trim(),


                password:
                document
                .getElementById('regPassword')
                .value


            })


        });




        const data =
        await res.json();




        if(!res.ok){


            errEl.textContent =
            data.error || 'שגיאה בהרשמה';


            return;

        }



        location.href =
        '/games.html';


    }


    catch{


        errEl.textContent =
        'שגיאת רשת - נסו שוב';


    }


});







// בדיקה אם המשתמש כבר מחובר - לא מבצעים הפניה אוטומטית, רק מציגים
// פס עדין למעלה שהמשתמש יכול ללחוץ עליו כדי להמשיך לאזור האישי
fetch('/admin/me')

.then(r=>r.json())

.then(d=>{


    if(d.authenticated){

        showAlreadyLoggedInBar(d);

    }


});

function showAlreadyLoggedInBar(d) {
    const label = d.role === 'admin' ? '🔐 מנהל מערכת' : `👤 ${d.username}`;

    const bar = document.createElement('div');
    bar.id = 'alreadyInBar';
    bar.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        background: rgba(20, 10, 14, 0.9);
        backdrop-filter: blur(6px);
        border-bottom: 1px solid rgba(252, 191, 92, 0.35);
        color: #fff8f0;
        font-size: 13.5px;
        padding: 10px 16px;
    `;
    bar.innerHTML = `
        <span>מחובר בתור ${label}</span>
        <span id="continueLink" style="
            color:#ffd76a; font-weight:700; cursor:pointer; text-decoration:underline;
        ">המשך לאזור האישי ←</span>
    `;
    document.body.prepend(bar);

    document.getElementById('continueLink').addEventListener('click', () => {
        location.href = '/games.html';
    });
}
