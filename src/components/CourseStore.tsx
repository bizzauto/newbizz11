import { useToast } from './Toast';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Clock, Users, Star, ShoppingCart, Loader2, Search, Play, CheckCircle, GraduationCap, ArrowLeft, Lock } from 'lucide-react';
import { coursesAPI } from '../lib/api';
import { useAuthStore } from '../lib/authStore';

interface Course {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  price: number;
  currency: string;
  accessType: string;
  enrollmentCount: number;
  rating: number;
  freeLessonCount: number;
  business?: { name: string; logoUrl?: string };
  _count?: { modules: number; enrollments: number };
}

interface CourseDetail {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  price: number;
  currency: string;
  accessType: string;
  enrollmentCount: number;
  rating: number;
  business?: { name: string; logoUrl?: string };
  modules: Array<{
    id: string;
    name: string;
    description?: string;
    lessons: Array<{
      id: string;
      title: string;
      description?: string;
      type: string;
      duration?: number;
      isFree: boolean;
    }>;
  }>;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function CourseStore() {
  const toast = useToast();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<CourseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [purchasing, setPurchasing] = useState(false);

  useEffect(() => {
    loadCourses();
  }, []);

  const loadCourses = async () => {
    try {
      setLoading(true);
      const res = await coursesAPI.getPublished({ search });
      if (res.data.success) {
        setCourses(res.data.data.courses);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  };

  const loadCourseDetail = async (courseId: string) => {
    try {
      setDetailLoading(true);
      const res = await coursesAPI.getPublicView(courseId);
      if (res.data.success) {
        setSelectedCourse(res.data.data);
      }
    } catch {
      // Silent fail
    } finally {
      setDetailLoading(false);
    }
  };

  const handleEnroll = async (course: CourseDetail) => {
    if (!isAuthenticated) {
      navigate('/login');
      return;
    }

    if (course.accessType === 'free' || course.price === 0) {
      try {
        await coursesAPI.enrollFree(course.id);
        navigate(`/course-player/${course.id}`);
      } catch {
        // Handle error
      }
      return;
    }

    // Paid course â€” initiate Razorpay
    startPayment(course);
  };

  /**
   * Dynamically load the Razorpay checkout script if not already loaded.
   * Returns a promise that resolves when the script is ready.
   */
  const loadRazorpayScript = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Razorpay SDK'));
      document.head.appendChild(script);
    });
  };

  const startPayment = async (course: CourseDetail) => {
    try {
      setPurchasing(true);

      // Ensure Razorpay SDK is loaded before proceeding
      await loadRazorpayScript();

      const res = await coursesAPI.createCheckout(course.id);
      if (!res.data.success) {
        toast.error(res.data.error || 'Failed to create checkout');
        return;
      }

      const { orderId, amount, currency, keyId } = res.data.data;

      const options = {
        key: keyId,
        amount: amount,
        currency: currency,
        name: course.name,
        description: `Enroll in ${course.name}`,
        order_id: orderId,
        handler: async (response: any) => {
          try {
            await coursesAPI.verifyPurchase(course.id, {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            navigate(`/course-player/${course.id}`);
          } catch {
            toast.error('Payment verification failed. Please contact support.');
          }
        },
        prefill: {
          email: localStorage.getItem('userEmail') || '',
        },
        theme: { color: '#3B82F6' },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.error || 'Payment failed. Please try again.';
      toast.success(msg);
    } finally {
      setPurchasing(false);
    }
  };

  if (selectedCourse) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 sm:px-6 py-4">
          <button onClick={() => setSelectedCourse(null)} className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
            <ArrowLeft size={20} />
            <span>Back to courses</span>
          </button>
        </div>

        {detailLoading ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin text-blue-600" size={32} /></div>
        ) : (
          <div className="max-w-4xl mx-auto p-4 sm:p-6">
            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {selectedCourse.thumbnail && (
                <img src={selectedCourse.thumbnail} alt={selectedCourse.name} className="w-full h-48 sm:h-64 object-cover" />
              )}
              <div className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{selectedCourse.name}</h1>
                    <p className="text-gray-600 dark:text-gray-400 mb-4">{selectedCourse.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                      {selectedCourse.price > 0 ? `${selectedCourse.currency} ${selectedCourse.price}` : 'Free'}
                    </p>
                    <button
                      onClick={() => handleEnroll(selectedCourse)}
                      disabled={purchasing}
                      className="mt-3 px-6 py-2.5 bg-gradient-to-r from-blue-600 to-orange-500 text-white rounded-xl font-medium hover:shadow-lg transition-all disabled:opacity-50"
                    >
                      {purchasing ? <Loader2 className="animate-spin inline" size={16} /> : selectedCourse.price > 0 ? 'Enroll Now' : 'Enroll Free'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 mt-6 text-sm text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-1"><BookOpen size={16} /> {selectedCourse.modules?.length || 0} Modules</span>
                  <span className="flex items-center gap-1"><Play size={16} /> {selectedCourse.modules?.reduce((s, m) => s + m.lessons.length, 0) || 0} Lessons</span>
                  <span className="flex items-center gap-1"><Users size={16} /> {selectedCourse.enrollmentCount} Students</span>
                </div>

                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mt-8 mb-4">Course Curriculum</h3>
                <div className="space-y-3">
                  {selectedCourse.modules?.map((module) => (
                    <div key={module.id} className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                      <div className="bg-gray-50 dark:bg-gray-750 px-4 py-3">
                        <h4 className="font-medium text-gray-900 dark:text-white">{module.name}</h4>
                        {module.description && <p className="text-sm text-gray-500 mt-1">{module.description}</p>}
                      </div>
                      <div className="divide-y divide-gray-100 dark:divide-gray-700">
                        {module.lessons.map((lesson) => (
                          <div key={lesson.id} className="px-4 py-2.5 flex items-center gap-3">
                            {lesson.isFree ? <Play size={14} className="text-green-500 flex-shrink-0" /> : <Lock size={14} className="text-gray-400 flex-shrink-0" />}
                            <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{lesson.title}</span>
                            {lesson.isFree && <span className="text-[10px] px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">Free</span>}
                            {lesson.duration && <span className="text-xs text-gray-400">{Math.floor(lesson.duration / 60)}m</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 sm:px-6 py-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <GraduationCap size={24} className="text-blue-600" />
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">Course Store</h1>
          </div>
          <p className="text-gray-500 dark:text-gray-400 mb-6">Discover courses to boost your skills</p>
          
          <div className="relative max-w-md">
            <Search size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search courses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadCourses()}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin text-blue-600" size={32} /></div>
        ) : courses.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen size={48} className="mx-auto text-gray-300 dark:text-gray-600 mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">No courses available</h3>
            <p className="text-gray-500">Check back later for new courses</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {courses.map((course) => (
              <div
                key={course.id}
                onClick={() => loadCourseDetail(course.id)}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-lg transition-all cursor-pointer group"
              >
                {course.thumbnail ? (
                  <img src={course.thumbnail} alt={course.name} className="w-full h-40 object-cover" />
                ) : (
                  <div className="w-full h-40 bg-gradient-to-br from-blue-600 to-orange-600 flex items-center justify-center">
                    <GraduationCap size={40} className="text-white/60" />
                  </div>
                )}
                <div className="p-4">
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-1 group-hover:text-blue-600 transition-colors">{course.name}</h3>
                  {course.description && <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 mb-3">{course.description}</p>}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                      <span className="flex items-center gap-1"><BookOpen size={12} /> {course._count?.modules || 0} mod</span>
                      <span className="flex items-center gap-1"><Users size={12} /> {course.enrollmentCount}</span>
                    </div>
                    {course.price > 0 ? (
                      <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{course.currency} {course.price}</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full font-medium">Free</span>
                    )}
                  </div>
                  {course.business && (
                    <p className="text-[10px] text-gray-400">by {course.business.name}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
